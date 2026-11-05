#!/usr/bin/env node
/**
 * The deployed site's acceptance checks: what only the live host can answer.
 *
 * These are the brief's checks against the real deployment — the request count and origins, the
 * policy as it is served, the `404`, the absolute `og:image` and sitemap, and the caching split. The
 * build-time half of each lives in `scripts/check.mjs`.
 *
 * Usage: `bun run live-check`, `node scripts/live-check.mjs [--site <url>]`. The first request is
 * retried for a bounded time, because a deploy that has just activated can take a moment to answer.
 */
import { createHash } from "node:crypto";
import { API_ORIGIN, DEFAULT_DOCS_URL, fetchDocument } from "./build.mjs";

const DEFAULT_SITE = "https://docs.edgarcnp.dev";
const ATTEMPTS = 6;
const BETWEEN = 5_000;

const results = [];

/** What the deployment reports without owning: another repository's answer, never a failure here. */
const advisories = [];

async function advisory(statement, run) {
  try {
    advisories.push({ statement, ok: true, note: await run() });
  } catch (error) {
    advisories.push({ statement, ok: false, note: error.message });
  }
}

async function check(statement, run) {
  try {
    const note = await run();
    results.push({ statement, ok: true, note });
  } catch (error) {
    results.push({ statement, ok: false, note: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/** One request, with the headers this script reads. */
async function get(url, { attempts = 1 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "manual", headers: { "cache-control": "no-cache" } });
      const body = Buffer.from(await response.arrayBuffer());
      if (response.status < 500 || attempt === attempts) {
        return { url, status: response.status, headers: response.headers, body };
      }
      last = `answered ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await pause(BETWEEN);
  }
  throw new Error(`${url} never answered: ${last}`);
}

/** The `sha256-<base64>` of every inline `<style>` block in a response body. */
function styleSources(body) {
  const hashes = [];
  let at = 0;
  for (;;) {
    const open = body.indexOf("<style", at);
    if (open < 0) return hashes;
    const tagEnd = body.indexOf(">", open + "<style".length);
    assert(tagEnd > 0, "the served page carries an inline <style> block with no closing '>'");
    const end = body.indexOf("</style>", tagEnd + 1);
    assert(end > 0, "the served page carries an inline <style> block with no closing tag");
    hashes.push(createHash("sha256").update(body.subarray(tagEnd + 1, end)).digest("base64"));
    at = end + "</style>".length;
  }
}

/** The subresources a served document loads: every `src`, and the `href` of a `<link>`. */
function subresources(html) {
  const found = new Set();
  for (const match of html.matchAll(/\bsrc="([^"]+)"/g)) found.add(match[1]);
  for (const match of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) found.add(match[1]);
  return [...found].filter((url) => url && !url.startsWith("data:"));
}

function directive(policy, name) {
  for (const part of policy.split(";")) {
    const [directiveName, ...sources] = part.trim().split(/\s+/);
    if (directiveName?.toLowerCase() === name) return sources;
  }
  return [];
}

/** The search index files the served page declares in its own metadata. */
function searchIndexes(html) {
  const raw = html.match(/<meta name="sourcey-search-indexes" content="([^"]*)"/)?.[1] ?? "";
  const decoded = raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  if (!decoded) return [];
  try {
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** The outcome of every check, in the order they ran, and the exit status they earn. */
function report() {
  for (const { statement, ok, note } of results) {
    process.stdout.write(`live-check: ${ok ? "ok" : "FAILED"} — ${statement}${note ? ` (${note})` : ""}\n`);
  }
  for (const { statement, ok, note } of advisories) {
    process.stdout.write(`live-check: ${ok ? "ok" : "warn"} — ${statement}${note ? ` (${note})` : ""}\n`);
  }
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`live-check: ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const site = argv[0] === "--site" && argv[1] ? argv[1].replace(/\/+$/, "") : DEFAULT_SITE;
  const origin = new URL(site).origin;
  process.stdout.write(`live-check: ${site}\n`);

  let home;
  try {
    home = await get(`${site}/`, { attempts: ATTEMPTS });
  } catch (error) {
    // A host that never answers is a failure of this check, not a crash: report it and stop, since
    // every other check reads the page this one could not fetch.
    results.push({ statement: "the site answers", ok: false, note: error.message });
    report();
    return;
  }
  const html = home.body.toString("utf8");
  const policy = home.headers.get("content-security-policy") ?? "";

  await check("the page answers 200 as HTML and revalidates", async () => {
    assert(home.status === 200, `answered ${home.status}`);
    const type = home.headers.get("content-type") ?? "";
    assert(type.startsWith("text/html"), `content-type is '${type}'`);
    const control = home.headers.get("cache-control") ?? "";
    assert(/must-revalidate/.test(control), `cache-control is '${control}'`);
    return `${home.body.length} bytes`;
  });

  await check("the policy is served, names the style block's hash, and allows nothing inline", async () => {
    assert(policy, "no content-security-policy header");
    assert(!policy.includes("unsafe-inline"), "the policy allows 'unsafe-inline'");
    assert(!policy.includes("unsafe-eval"), "the policy allows 'unsafe-eval'");
    const named = directive(policy, "style-src").filter((source) => source.startsWith("'sha256-"));
    assert(named.length, `style-src names no hash: ${directive(policy, "style-src").join(" ")}`);
    const served = styleSources(home.body);
    assert(served.length, "the page carries no inline <style> block");
    const hashed = new Set(named.map((source) => source.slice("'sha256-".length, -1)));
    const missed = served.filter((digest) => !hashed.has(digest));
    assert(!missed.length, `style-src does not name ${missed.join(", ")}: the styles would be blocked`);
    return `${named.length} hash over ${served.length} block`;
  });

  await check("the policy names only the API's origin, and only to connect", async () => {
    const connect = directive(policy, "connect-src");
    assert(
      connect.length === 2 && connect[0] === "'self'" && connect[1] === API_ORIGIN,
      `connect-src is ${connect.join(" ")}`,
    );
    const elsewhere = policy
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !/^connect-src/i.test(part) && /https?:\/\//i.test(part));
    assert(!elsewhere.length, `the policy allows ${elsewhere.join("; ")}`);
    return `connect-src 'self' ${API_ORIGIN}`;
  });

  await check("every subresource answers 200 on this origin", async () => {
    const named = subresources(html);
    assert(named.length, "the page names no subresource");
    const answers = await Promise.all(
      named.map(async (url) => {
        const absolute = url.startsWith("/") ? `${site}${url}` : url;
        assert(absolute.startsWith(`${origin}/`), `${url} leaves this origin`);
        const response = await get(absolute, { attempts: 2 });
        assert(response.status === 200, `${url} answered ${response.status}`);
        return absolute;
      }),
    );
    return `${answers.length} requests, all 200`;
  });

  await check("the search indexes the page declares answer 200", async () => {
    const declared = searchIndexes(html);
    assert(declared.length, "the page declares no search index");
    const responses = await Promise.all(
      declared.map((url) => get(url.startsWith("/") ? `${site}${url}` : url, { attempts: 2 })),
    );
    const refused = responses.filter((response) => response.status !== 200);
    assert(
      !refused.length,
      refused.map((response) => `${response.url} answered ${response.status}`).join(", "),
    );
    return `${declared.length} index file(s)`;
  });

  await check("the content-addressed directories are immutable", async () => {
    const asset = subresources(html).find((url) => url.includes("/_assets/"));
    assert(asset, "the page loads nothing from /_assets/");
    const response = await get(asset.startsWith("/") ? `${site}${asset}` : asset, { attempts: 2 });
    const control = response.headers.get("cache-control") ?? "";
    assert(/immutable/.test(control), `_assets answers '${control}'`);
    return control;
  });

  await check("an unknown path answers the site's own 404", async () => {
    const response = await get(`${site}/no-such-page-${Date.now()}`);
    assert(response.status === 404, `answered ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    assert(type.startsWith("text/html"), `content-type is '${type}'`);
    const body = response.body.toString("utf8");
    assert(body.includes("Page not found"), "the body is not the site's not-found page");
    return "404.html";
  });

  await check("og:image resolves to the deployed card", async () => {
    const image = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    assert(image, "the page names no og:image");
    assert(image.startsWith(`${origin}/`), `og:image is ${image}`);
    const response = await get(image, { attempts: 2 });
    assert(response.status === 200, `${image} answered ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    assert(type.startsWith("image/png"), `og:image content-type is '${type}'`);
    return image;
  });

  await check("sitemap.xml lists absolute URLs on this origin", async () => {
    const response = await get(`${site}/sitemap.xml`, { attempts: 2 });
    assert(response.status === 200, `answered ${response.status}`);
    const locations = [...response.body.toString("utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    assert(locations.length, "sitemap.xml lists nothing");
    const foreign = locations.filter((url) => !url.startsWith(`${site}/`));
    assert(!foreign.length, `sitemap.xml lists ${foreign.join(", ")}`);
    return `${locations.length} URL(s)`;
  });

  await advisory("the console can read the API's answers from this origin", async () => {
    // The console's requests are cross-origin, so the browser reads an answer only when the API
    // allows this origin. That allowance lives in the API's repository, which makes it a report
    // rather than a failure of this deploy: the page and its policy are right either way.
    const response = await fetch(`${API_ORIGIN}/v1/health`, { headers: { origin: site } });
    assert(response.status === 200, `the API answered ${response.status} to ${API_ORIGIN}/v1/health`);
    const allow = response.headers.get("access-control-allow-origin");
    assert(allow === site, `the API answers no access-control-allow-origin for ${site} (it sends '${allow ?? ""}')`);
    return `${API_ORIGIN} allows ${site}`;
  });

  await check("the page names the version the API serves now", async () => {
    const { version } = await fetchDocument(process.env.DOCS_URL || DEFAULT_DOCS_URL);
    assert(html.includes(`v${version}`), `the page names no v${version} (the API serves it now)`);
    return `v${version}`;
  });

  report();
}

main().catch((error) => {
  process.stderr.write(`live-check: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
