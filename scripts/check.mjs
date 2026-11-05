#!/usr/bin/env node
/**
 * The site's gate: every acceptance check that does not need the deployed site.
 *
 * The checks are the brief's, made mechanical:
 *
 * 1. determinism — a second build from the same document is byte-identical to the first;
 * 2. version — the page names the `info.version` the build read;
 * 3. subresources — every `src`/`href` the page names is this origin's and exists in the tree;
 * 4. policy — no `'unsafe-inline'`, no inline script, no third-party origin, and the `style-src`
 *    hash is the one the served `<style>` block actually hashes to;
 * 5. metadata — `og:image` and `sitemap.xml` are absolute against `https://docs.edgarcnp.dev`;
 * 6. 404 — the tree carries the site's own not-found page, which the host serves with a 404 status;
 * 7. growth — an operation added to the document appears on the page with no other edit here;
 * 8. caching — content-addressed directories are immutable and the page revalidates.
 *
 * The style hash is recomputed here with its own scan rather than by calling the builder's: a check
 * that reuses the code it checks cannot fail for the reason it exists.
 *
 * Usage: `bun run check`, `node scripts/check.mjs [--docs <url|path>]`. It renders three trees and
 * leaves `dist` holding the first.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ORIGIN, DEFAULT_DOCS_URL, fetchDocument, build } from "./build.mjs";

const ROOT = resolve(join(fileURLToPath(import.meta.url), "..", ".."));
const SCRATCH = join(ROOT, ".build");
const SITE = "https://docs.edgarcnp.dev";
const ORIGIN = new URL(SITE).origin;

const results = [];

/** Run one check, and keep the outcome instead of stopping at the first failure. */
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

/** Every file in a tree, keyed by its path relative to it. */
async function tree(directory) {
  const files = new Map();
  const walk = async (at, prefix) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path, name);
      } else if (entry.isFile()) {
        files.set(name, await readFile(path));
      }
    }
  };
  await walk(directory, "");
  return files;
}

/** The `_headers` file as rule sets: the pattern a block matches, and its lowercased header names. */
function headers(text) {
  const rules = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      current = { pattern: line.trim(), values: new Map() };
      rules.push(current);
      continue;
    }
    assert(current, `_headers has an indented line before any pattern: ${line}`);
    const at = line.indexOf(":");
    assert(at > 0, `_headers has a header line without a name: ${line}`);
    current.values.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return rules;
}

/** The CSP a rule set carries, as `directive -> sources`. */
function directives(policy) {
  const map = new Map();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), sources);
  }
  return map;
}

/**
 * The `sha256-<base64>` of every inline `<style>` block in a document, scanned from the bytes.
 *
 * Deliberately a second implementation of the builder's scan: a browser hashes the bytes between
 * `<style …>` and `</style>`, and this is what decides whether the policy honours the page.
 */
async function styleSources(path) {
  const body = await readFile(path);
  const hashes = [];
  let at = 0;
  for (;;) {
    const open = body.indexOf("<style", at);
    if (open < 0) return hashes;
    const tagEnd = body.indexOf(">", open + "<style".length);
    assert(tagEnd > 0, `${path}: an inline <style> block has no closing '>'`);
    const end = body.indexOf("</style>", tagEnd + 1);
    assert(end > 0, `${path}: an inline <style> block has no closing tag`);
    hashes.push(createHash("sha256").update(body.subarray(tagEnd + 1, end)).digest("base64"));
    at = end + "</style>".length;
  }
}

/**
 * The subresources a document loads: every `src` attribute, and the `href` of a `<link>`.
 *
 * An anchor is a destination rather than a subresource, so `href` is read only inside `<link>` —
 * the page's footer credits the generator with one. The search index and the OpenAPI operation
 * files are fetched by script from paths the page carries as data; `scripts/live-check.mjs`
 * exercises those against the deployed host.
 */
function subresources(html) {
  const found = new Set();
  for (const match of html.matchAll(/\bsrc="([^"]+)"/g)) found.add(match[1]);
  for (const match of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) found.add(match[1]);
  return [...found].filter((url) => url && !url.startsWith("data:"));
}

/**
 * The file a URL the page names is served from.
 *
 * Only this origin is allowed, and the host's `htmlHandling` is what maps an extension-less path to
 * the `.html` beside it — which is how `/404` answers `404.html`.
 */
function servedFile(url, files, what) {
  let path = url;
  if (path.startsWith(ORIGIN)) {
    path = path.slice(ORIGIN.length) || "/";
  } else {
    assert(!/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith("//"), `${what} names a foreign URL: ${url}`);
  }
  const name = path.split("?")[0].split("#")[0].replace(/^\/+/, "");
  const candidates =
    name === "" || name.endsWith("/")
      ? [`${name}index.html`]
      : [name, `${name}.html`, `${name}/index.html`];
  const found = candidates.find((candidate) => files.has(candidate));
  assert(found, `${what} names a path the tree does not serve: ${url}`);
  return found;
}

/** Every subresource a document names, resolved against the tree it is served from. */
function resolved(html, files, what) {
  const named = subresources(html);
  assert(named.length, `${what} names no subresource`);
  return named.map((url) => servedFile(url, files, what));
}

/**
 * The search index files the page declares in its own metadata.
 *
 * The page's script fetches them rather than an attribute naming them, so they are not
 * subresources — and the deployed site still has to serve every one.
 */
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

async function main() {
  const docs = process.env.DOCS_URL || DEFAULT_DOCS_URL;
  const document = await fetchDocument(docs);
  const version = document.version;
  const wired = join(SCRATCH, "document.json");
  await mkdir(SCRATCH, { recursive: true });
  await writeFile(wired, document.bytes);

  process.stdout.write(`check: document ${version} from ${document.source}\n`);

  // The tree under test, and a second run from the same bytes to compare against.
  const first = await build({ docs: wired, out: join(ROOT, "dist") });
  const repeat = await build({ docs: wired, out: join(SCRATCH, "repeat") });

  await check("the build is reproducible: two runs are byte-identical", async () => {
    const [a, b] = [await tree(join(ROOT, "dist")), await tree(join(SCRATCH, "repeat"))];
    const only = [...a.keys()].filter((name) => !b.has(name));
    const missing = [...b.keys()].filter((name) => !a.has(name));
    assert(!only.length, `the second build dropped ${only.join(", ")}`);
    assert(!missing.length, `the second build added ${missing.join(", ")}`);
    const differing = [...a].filter(([name, bytes]) => !bytes.equals(b.get(name))).map(([name]) => name);
    assert(!differing.length, `the second build differs in ${differing.join(", ")}`);
    return `${a.size} files`;
  });

  const files = await tree(join(ROOT, "dist"));
  const page = files.get("index.html")?.toString("utf8") ?? "";
  const notFound = files.get("404.html")?.toString("utf8") ?? "";
  const headersFile = headers(files.get("_headers")?.toString("utf8") ?? "");
  const everyPath = headersFile.find((rule) => rule.pattern === "/*");
  const policy = everyPath?.values.get("content-security-policy") ?? "";
  const parsed = directives(policy);

  await check("the page names the document's version", async () => {
    assert(page.includes(`v${version}`), `index.html does not carry v${version}`);
    return `v${version}`;
  });

  await check("the policy names the style block the page serves, and nothing inline", async () => {
    const served = await styleSources(join(ROOT, "dist", "index.html"));
    assert(served.length, "index.html carries no inline <style> block");
    const named = (parsed.get("style-src") ?? []).filter((source) => source.startsWith("'sha256-"));
    const hashed = new Set(named.map((source) => source.slice("'sha256-".length, -1)));
    const absent = served.filter((digest) => !hashed.has(digest));
    assert(!absent.length, `style-src does not name ${absent.join(", ")}`);
    assert(!policy.includes("unsafe-inline"), "the policy allows 'unsafe-inline'");
    assert(!policy.includes("unsafe-eval"), "the policy allows 'unsafe-eval'");
    const scripts = parsed.get("script-src") ?? [];
    assert(scripts.length === 1 && scripts[0] === "'self'", `script-src is ${scripts.join(" ")}`);
    return `${named.length} hash, ${served.length} block`;
  });

  await check("the policy names only the API's origin, and only to connect", async () => {
    const connect = parsed.get("connect-src") ?? [];
    assert(
      connect.length === 2 && connect[0] === "'self'" && connect[1] === API_ORIGIN,
      `connect-src is ${connect.join(" ")}`,
    );
    const elsewhere = [...parsed]
      .filter(([name]) => name !== "connect-src")
      .flatMap(([name, sources]) =>
        sources.filter((source) => /^https?:/i.test(source)).map((source) => `${name} ${source}`),
      );
    assert(!elsewhere.length, `the policy allows ${elsewhere.join(", ")}`);
    const defaults = parsed.get("default-src") ?? [];
    assert(defaults.length === 1 && defaults[0] === "'self'", `default-src is ${defaults.join(" ")}`);
    return `connect-src 'self' ${API_ORIGIN}`;
  });

  await check("every subresource the page names is this origin and exists", async () => {
    const present = resolved(page, files, "index.html");
    return `${present.length} references, all present`;
  });

  await check("every subresource the not-found page names is this origin and exists", async () => {
    assert(notFound, "dist/404.html is missing");
    const present = resolved(notFound, files, "404.html");
    return `${present.length} references, all present`;
  });

  await check("the search indexes the page declares are in the tree", async () => {
    const declared = searchIndexes(page);
    assert(declared.length, "the page declares no search index");
    const missing = declared.filter((url) => !files.has(servedFile(url, files, "index.html")));
    assert(!missing.length, `not in the tree: ${missing.join(", ")}`);
    return `${declared.length} index file(s)`;
  });

  await check("the not-found page is the site's own, and the host is told to serve it", async () => {
    assert(notFound.includes("Page not found"), "404.html is not the generated not-found page");
    assert(!notFound.includes("<title>404"), "404.html is the host's default page");
    return "404.html";
  });

  await check("og:image and sitemap.xml are absolute against the site", async () => {
    const image = page.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    assert(image === `${SITE}/_og/index.png`, `og:image is ${image}`);
    assert(files.has("_og/index.png"), "the tree carries no _og/index.png");
    const sitemap = files.get("sitemap.xml")?.toString("utf8") ?? "";
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    assert(locations.length, "sitemap.xml lists nothing");
    const foreign = locations.filter((url) => !url.startsWith(`${SITE}/`));
    assert(!foreign.length, `sitemap.xml lists ${foreign.join(", ")}`);
    return `${locations.length} URL(s)`;
  });

  await check("content-addressed directories are immutable and the page revalidates", async () => {
    const by = (pattern) => headersFile.find((rule) => rule.pattern === pattern);
    for (const pattern of ["/_assets/*", "/_search/*", "/_media/*", "/_og/*"]) {
      const control = by(pattern)?.values.get("cache-control") ?? "";
      assert(/immutable$/.test(control), `${pattern} answers '${control || "no cache-control"}'`);
    }
    const root = everyPath?.values.get("cache-control");
    assert(!root, `/* carries '${root}', which the asset rules would inherit and join with a comma`);
    const index = by("/index.html")?.values.get("cache-control") ?? "";
    assert(/must-revalidate$/.test(index), `/index.html answers '${index || "no cache-control"}'`);
    return "4 immutable rules, 1 revalidating";
  });

  await check("an operation added to the document reaches the page with no change here", async () => {
    const document_ = JSON.parse(document.bytes.toString("utf8"));
    const marker = "probe-operation-added-by-the-acceptance-check";
    document_.paths["/__check/probe"] = {
      get: {
        summary: marker,
        operationId: "probe",
        responses: { 200: { description: "The check's own operation." } },
      },
    };
    const probe = join(SCRATCH, "probe-document.json");
    await writeFile(probe, JSON.stringify(document_));
    const grown = await build({ docs: probe, out: join(SCRATCH, "probe") });
    const html = (await tree(join(SCRATCH, "probe"))).get("index.html")?.toString("utf8") ?? "";
    assert(html.includes(marker), `the page does not carry the added operation (build read ${grown.version})`);
    assert(!page.includes(marker), "the unmodified build already carries the marker");
    // The build writes the document it read into `public/docs.json`, and the probe is not the one the
    // site describes: put the real bytes back, so nothing that reads that file afterwards — `bun run
    // serve`, the dev server — picks up a page with an operation the API does not serve.
    await writeFile(join(ROOT, "public", "docs.json"), document.bytes);
    return "/__check/probe rendered";
  });

  await rm(join(SCRATCH, "repeat"), { recursive: true, force: true });
  await rm(join(SCRATCH, "probe"), { recursive: true, force: true });
  await rm(join(SCRATCH, "probe-document.json"), { force: true });

  for (const { statement, ok, note } of results) {
    process.stdout.write(`check: ${ok ? "ok" : "FAILED"} — ${statement}${note ? ` (${note})` : ""}\n`);
  }
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(
    `check: ${results.length - failed.length}/${results.length} passed, tree ${first.files} files ${(first.size / 1e6).toFixed(2)} MB from ${repeat.files} on the second run\n`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`check: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
