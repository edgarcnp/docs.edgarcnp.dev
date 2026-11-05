#!/usr/bin/env node
/**
 * Serve the built tree the way the Worker serves it, from one process with no module graph.
 *
 * `sourcey dev` renders with Vite: the page it answers loads its client from `/node_modules/…?v=…`
 * and a `ws://…?token=…` for live reload. None of those URLs exist in production, and they are not
 * what the deployment's policy describes — so the dev page can be dead while the shipped site is
 * fine, and a policy mistake (a missing `connect-src`, a stale style hash) is invisible until after
 * the deploy.
 *
 * This server answers from `dist` as it stands and applies `dist/_headers`, which the build writes
 * from the same template the Worker reads:
 *
 * - every rule the request matches contributes its headers, and a header two rules set is joined
 *   with a comma — Cloudflare's own rule, and the reason `/*` carries no `cache-control` here;
 * - a path matching no file answers `404.html` with a 404 status (`notFoundHandling: "404-page"`);
 * - `/404` answers `404.html` with 200, `/foo/` answers `foo/index.html` (`htmlHandling:
 *   "auto-trailing-slash"`), and `/foo` answers `foo.html` beside it;
 * - `_headers` is never served, and `ETag`, `304` and the default `cache-control` behave as the
 *   asset layer's do — so `/` revalidates without any rule naming it.
 *
 * It is a *check*, not a replacement for `bun run dev`: it does not render, watch or reload, so a
 * change needs `bun run build` and a page reload. Usage: `bun run serve [--port <port>]`.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(fileURLToPath(import.meta.url), "..", ".."));
const TREE = join(ROOT, "dist");
const DEFAULT_PORT = 4401;

/** The response body for a file, and the status it is served with. */
const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;
const STATUS_NOT_MODIFIED = 304;

/** The asset layer's own cache rule, for a response no `_headers` rule sets one for. */
const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate";

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
]);

/**
 * `_headers` as rule sets, in file order.
 *
 * A pattern line at column zero opens a rule; indented `name: value` lines fill it. A name a rule
 * declares twice is joined with a comma, as Cloudflare joins it — the format has no "last wins".
 */
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      current = { pattern: line.trim(), headers: new Map() };
      rules.push(current);
      continue;
    }
    if (!current) throw new Error(`_headers has an indented line before any pattern: ${line}`);
    const at = line.indexOf(":");
    if (at < 0) throw new Error(`_headers has a header line without a name: ${line}`);
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    const previous = current.headers.get(name);
    current.headers.set(name, previous === undefined ? value : `${previous}, ${value}`);
  }
  return rules;
}

/** Whether a `_headers` pattern matches a request path. One splat, greedy, as the format allows. */
function matches(pattern, pathname) {
  const star = pattern.indexOf("*");
  if (star < 0) return pathname === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    pathname.length >= prefix.length + suffix.length &&
    pathname.startsWith(prefix) &&
    pathname.endsWith(suffix)
  );
}

/** Every header the request's path earns, each name from every rule that matches it. */
function headersFor(rules, pathname) {
  const merged = new Map();
  for (const rule of rules) {
    if (!matches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) {
      const previous = merged.get(name);
      // Cloudflare joins a header two rules set rather than letting one win; a local server that
      // overwrote instead would hide exactly the duplication `scripts/check.mjs` refuses in `/*`.
      merged.set(name, previous === undefined ? value : `${previous}, ${value}`);
    }
  }
  return merged;
}

/**
 * The headers the asset layer adds on its own.
 *
 * `cache-control: public, max-age=0, must-revalidate` is what Workers answers with when the request
 * carries neither `Authorization` nor `Range` and no rule overrides it — which is why a request for
 * `/` revalidates even though `_headers` only names `/index.html`.
 */
function applyAssetDefaults(headers) {
  if (!headers.has("cache-control")) headers.set("cache-control", DEFAULT_CACHE_CONTROL);
  return headers;
}

/**
 * The files a request path may be served from, in the order the asset layer tries them.
 *
 * `htmlHandling: "auto-trailing-slash"` is what maps `/404` to `404.html`; the first candidate that
 * exists wins, and the caller reports a miss only when none does.
 */
function candidates(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return [];
  }
  if (decoded.endsWith("/")) return [`${decoded}index.html`];
  return [decoded, `${decoded}.html`, `${decoded}/index.html`];
}

/** The file inside the served tree a path names, or null when it leaves the tree or does not exist. */
async function resolveFile(pathname) {
  for (const candidate of candidates(pathname)) {
    const path = resolve(join(TREE, candidate));
    if (path !== TREE && !path.startsWith(TREE + sep)) continue;
    try {
      const info = await stat(path);
      if (info.isFile()) return { path, size: info.size, modified: info.mtimeMs };
    } catch {
      // Not every candidate exists: `/404` tries three names and usually has one.
    }
  }
  return null;
}

/** The tree the build must have written before this server has anything to say. */
async function readTree() {
  let headers;
  try {
    headers = await readFile(join(TREE, "_headers"), "utf8");
  } catch {
    throw new Error(`no ${join(TREE, "_headers")}: run 'bun run build' first`);
  }
  return parseHeaders(headers);
}

/** A validator from the file's own bytes and time, as the asset layer's `ETag` is. */
function etagFor(file) {
  return `"${file.size.toString(16)}-${Math.floor(file.modified).toString(16)}"`;
}

function send(response, status, headers, body) {
  response.writeHead(status, Object.fromEntries(headers));
  response.end(body);
}

async function handle(rules, request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // `_headers` and `_redirects` are configuration, not assets: Workers parses them and never serves
  // them, so a request for one is a request for something that is not there.
  if (pathname === "/_headers" || pathname === "/_redirects") {
    return respondMissing(rules, pathname, response);
  }

  const file = await resolveFile(pathname);
  if (file === null) return respondMissing(rules, pathname, response);

  const headers = applyAssetDefaults(headersFor(rules, pathname));
  headers.set("content-type", TYPES.get(extname(file.path).toLowerCase()) ?? "application/octet-stream");
  headers.set("etag", etagFor(file));

  if (request.headers["if-none-match"] === headers.get("etag")) {
    headers.delete("content-type");
    return send(response, STATUS_NOT_MODIFIED, headers, "");
  }

  if (request.method === "HEAD") return send(response, STATUS_OK, headers, "");
  response.writeHead(STATUS_OK, Object.fromEntries(headers));
  createReadStream(file.path).on("error", () => response.destroy()).pipe(response);
  return undefined;
}

/** The tree's own not-found page, with a 404 status — `notFoundHandling: "404-page"`. */
async function respondMissing(rules, pathname, response) {
  const page = await resolveFile("/404.html").catch(() => null);
  const headers = applyAssetDefaults(headersFor(rules, pathname));
  if (page === null) {
    headers.set("content-type", "text/plain; charset=utf-8");
    return send(response, STATUS_NOT_FOUND, headers, `404: the tree carries no 404.html\n`);
  }
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("etag", etagFor(page));
  process.stderr.write(`serve: ${pathname} is not in the tree; answering 404.html\n`);
  response.writeHead(STATUS_NOT_FOUND, Object.fromEntries(headers));
  createReadStream(page.path).pipe(response);
  return undefined;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--port" || flag === "-p") {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${flag} needs a port number`);
      options.port = Number(value);
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${flag}: usage is 'serve.mjs [--port <port>]'`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("usage: serve.mjs [--port <port>]\n");
    return;
  }
  const rules = await readTree();
  const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT);

  const server = createServer((request, response) => {
    handle(rules, request, response).catch((error) => {
      process.stderr.write(`serve: ${request.url} failed: ${error.message}\n`);
      if (!response.headersSent) send(response, 500, new Map(), "500\n");
      else response.destroy();
    });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(
        `serve: port ${port} is held by another process — 'sourcey dev' takes 4400; pass --port <n> for a free one\n`,
      );
    } else {
      process.stderr.write(`serve: ${error.message}\n`);
    }
    process.exitCode = 1;
  });

  server.listen(port, "localhost", () => {
    process.stdout.write(`serve: ${TREE} on http://localhost:${port}/ (policy and cache rules from _headers)\n`);
    process.stdout.write("serve: the tree is served as it stands — rebuild and reload to see a change\n");
  });
}

main().catch((error) => {
  process.stderr.write(`serve: ${error.message}\n`);
  process.exitCode = 1;
});
