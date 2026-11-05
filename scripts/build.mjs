#!/usr/bin/env node
/**
 * The site's builder: one document in, one static tree out.
 *
 * 1. Fetch `GET /docs` from the API and fail on a non-200 answer, on a body that is not JSON, and
 *    on a document without `paths` or `info.version`. A page generated from a stale or truncated
 *    document is worse than no deploy, so nothing here is best-effort.
 * 2. Write it to `public/docs.json`, the path `sourcey.config.ts` reads.
 * 3. Render into `.build/site`, never over `dist`. Sourcey writes content-addressed directories
 *    (`_assets/<hash>/`, `_search/<hash>/`) and removes nothing, so a build over an old tree leaves
 *    the previous hash beside the new one; rendering beside the live tree and replacing it only on
 *    success also means a failed build leaves the last good site intact.
 * 4. Name the page's inline `<style>` blocks in the Content-Security-Policy as `sha256-<base64>` of
 *    their exact bytes, and fail when a block cannot be read. A stale hash is a page whose styles
 *    the browser silently blocks.
 * 5. Replace `dist` with the finished tree.
 *
 * Usage: `bun run build`, `node scripts/build.mjs [--docs <url|path>] [--out <dir>]`.
 * `DOCS_URL` in the environment overrides the default document address.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = join(ROOT, ".build", "site");
const OUTPUT = join(ROOT, "dist");
const DOCUMENT = join(ROOT, "public", "docs.json");

/** Where the document is served unless the caller names another address. */
export const DEFAULT_DOCS_URL = "https://api.edgarcnp.dev/docs";

/** The origin every URL the page emits is absolute against. */
const SITE_ORIGIN = "https://docs.edgarcnp.dev";

/** The API's origin: the one cross-origin target the page has, and only for its console. */
export const API_ORIGIN = new URL(DEFAULT_DOCS_URL).origin;

/**
 * The response policy, as the host reads it: one rule set for every path, one for each
 * content-addressed directory, and one for the page itself.
 *
 * `style-src` carries the hash of the emitted `<style>` block and never `'unsafe-inline'`; the
 * placeholder is replaced from the bytes actually served. `connect-src` is the only directive that
 * names another origin — the console sends its requests to the API the document declares — and every
 * other directive names this origin alone, which is why `img-src` does not carry the API's
 * `https://edgarcnp.dev` allowance: nothing in the tree loads it.
 */
const HEADERS = `/*
  x-content-type-options: nosniff
  x-frame-options: DENY
  referrer-policy: no-referrer
  cross-origin-resource-policy: same-origin
  strict-transport-security: max-age=31536000; includeSubDomains
  content-security-policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' {{STYLE_SOURCES}}; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ${API_ORIGIN}

/_assets/*
  cache-control: public, max-age=31536000, immutable

/_search/*
  cache-control: public, max-age=31536000, immutable

/_media/*
  cache-control: public, max-age=31536000, immutable

/_og/*
  cache-control: public, max-age=31536000, immutable

/index.html
  cache-control: public, max-age=0, must-revalidate
`;

/** A build failure the operator can act on: printed as one line, without a stack. */
export class BuildError extends Error {}

/**
 * The document, from its address or from a file on disk.
 *
 * A file source is what `scripts/check.mjs` uses: it builds the same bytes twice, and once more
 * from a document with an extra operation, which is how "a new endpoint appears with no change
 * here" is proven rather than assumed.
 */
export async function fetchDocument(source = DEFAULT_DOCS_URL) {
  const address = source.startsWith("http://") || source.startsWith("https://");
  const bytes = address ? await download(source) : await readFile(resolve(source));
  const version = validateDocument(bytes, source);
  return { bytes, version, source };
}

async function download(source) {
  const response = await fetch(source, {
    // `must-revalidate` plus an `ETag` is what the endpoint answers with, so a conditional request
    // is normal; `no-cache` sends the revalidation this build needs and no stored copy is reused.
    headers: { accept: "application/json", "cache-control": "no-cache" },
  });
  if (!response.ok) {
    throw new BuildError(`${source} answered ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The version the document declares, or a failure naming what is wrong with it. */
export function validateDocument(bytes, source = "the document") {
  let document;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new BuildError(`${source} is not UTF-8 JSON: ${error.message}`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new BuildError(`${source} is not a JSON object`);
  }
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.")) {
    throw new BuildError(
      `${source} declares openapi ${JSON.stringify(document.openapi)}; this site renders OpenAPI 3.x`,
    );
  }
  if (typeof document.paths !== "object" || document.paths === null || !Object.keys(document.paths).length) {
    throw new BuildError(`${source} carries no paths: a page built from it would have nothing to show`);
  }
  const version = document.info?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new BuildError(`${source} carries no info.version: the page could not name the API it describes`);
  }
  return version;
}

/**
 * The document the generator reads, written whole or not at all.
 * The pending file sits beside the target, so the rename is atomic: a failure between here and the
 * generator leaves the previous document, never a truncated one.
 */
async function writeDocument(bytes) {
  await mkdir(dirname(DOCUMENT), { recursive: true });
  const pending = `${DOCUMENT}.pending`;
  await writeFile(pending, bytes);
  await rename(pending, DOCUMENT);
}

/** Render the tree into `out`, from an empty directory. */
async function generate(out) {
  const sourcey = join(ROOT, "node_modules", ".bin", "sourcey");
  if (!existsSync(sourcey)) {
    throw new BuildError(`${sourcey} is not installed: run 'bun install'`);
  }
  // The generator is a `#!/usr/bin/env node` script, and `bun run` honours that shebang rather than
  // replacing it — so a host with Bun and no Node looks installed and fails at the last moment.
  // Naming it here is the difference between a failed build and a mystery: the shell's own
  // `env: 'node': No such file or directory` scrolls out of sight.
  if (spawnSync("node", ["--version"], { stdio: "ignore" }).error) {
    throw new BuildError(
      `${sourcey} runs on Node and 'node' is not on PATH: this build needs Node as well as Bun (see README)`,
    );
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(dirname(out), { recursive: true });
  const run = spawnSync(sourcey, ["build", "-o", out], { cwd: ROOT, stdio: "inherit" });
  if (run.error) {
    throw new BuildError(`${sourcey} could not run: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new BuildError(`sourcey exited ${run.status ?? run.signal}`);
  }
  for (const required of ["index.html", ".sourcey-output.json"]) {
    if (!existsSync(join(out, required))) {
      throw new BuildError(`the build wrote no ${required} into ${out}`);
    }
  }
}

/**
 * Every inline `<style>` block in the page, as the CSP source expression of its exact bytes.
 *
 * The bytes between `<style …>` and `</style>` are what a browser hashes, attributes or no
 * attributes, so the scan takes them verbatim.
 */
async function styleSources(directory) {
  const sources = new Set();
  let blocks = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    const body = await readFile(join(directory, entry.name));
    let at = 0;
    for (;;) {
      const open = body.indexOf("<style", at);
      if (open < 0) break;
      const tagEnd = body.indexOf(">", open + "<style".length);
      const end = tagEnd < 0 ? -1 : body.indexOf("</style>", tagEnd + 1);
      if (end < 0) {
        throw new BuildError(`${entry.name}: an inline <style> block has no closing tag`);
      }
      const digest = createHash("sha256").update(body.subarray(tagEnd + 1, end)).digest("base64");
      sources.add(`'sha256-${digest}'`);
      blocks += 1;
      at = end + "</style>".length;
    }
  }
  if (!blocks) {
    throw new BuildError(`${directory} carries no inline <style> block, so the policy would name no hash`);
  }
  // Sorted, because the header is part of the build's output and two runs must agree byte for byte.
  return { sources: [...sources].sort(), blocks };
}

/** Write `_headers` into the tree, and read it back to prove the policy names the block it serves. */
async function writeHeaders(directory, sources) {
  const headers = HEADERS.replace("{{STYLE_SOURCES}}", sources.join(" "));
  const path = join(directory, "_headers");
  await writeFile(path, headers);
  const written = await readFile(path, "utf8");
  for (const source of sources) {
    if (!written.includes(source)) {
      throw new BuildError(`${path} does not name ${source}: the served styles would be blocked`);
    }
  }
}

/** Put the finished tree in place, and only a tree this script generated. */
async function publish(staging, out) {
  if (existsSync(out)) {
    if (!existsSync(join(out, ".sourcey-output.json"))) {
      throw new BuildError(`${out} is not a generated tree, so it is not replaced: move it aside by hand`);
    }
    await rm(out, { recursive: true, force: true });
  }
  await mkdir(dirname(out), { recursive: true });
  await rename(staging, out);
}

/** The tree's file count and size, for the line the build prints when it is done. */
async function measure(directory) {
  let files = 0;
  let size = 0;
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files += 1;
        size += (await readFile(path)).length;
      }
    }
  };
  await walk(directory);
  return { files, size };
}

/**
 * Build the site.
 *
 * Returns what the run produced, so `scripts/check.mjs` asserts on the same values the operator
 * sees rather than re-deriving them.
 */
export async function build({ docs = process.env.DOCS_URL || DEFAULT_DOCS_URL, out = OUTPUT } = {}) {
  const document = await fetchDocument(docs);
  await writeDocument(document.bytes);
  try {
    await generate(STAGING);
    const styles = await styleSources(STAGING);
    await writeHeaders(STAGING, styles.sources);
    await publish(STAGING, out);
    const tree = await measure(out);
    return { version: document.version, source: document.source, out, ...tree, ...styles };
  } finally {
    // A failed build leaves no half-rendered tree behind for the next one to inherit.
    await rm(STAGING, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--docs" || flag === "--out") {
      const value = argv[index + 1];
      if (value === undefined) throw new BuildError(`${flag} needs a value`);
      options[flag.slice(2)] = value;
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else {
      throw new BuildError(`unknown argument ${flag}: usage is 'build.mjs [--docs <url|path>] [--out <dir>]'`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("usage: build.mjs [--docs <url|path>] [--out <dir>]\n");
    return;
  }
  const result = await build(options);
  process.stdout.write(`build: ${result.source} declares version ${result.version}\n`);
  process.stdout.write(
    `build: the policy names ${result.sources.length} style source over ${result.blocks} inline block(s)\n`,
  );
  process.stdout.write(
    `build: ${result.out} holds ${result.files} files, ${(result.size / 1e6).toFixed(2)} MB, absolute against ${SITE_ORIGIN}\n`,
  );
}

// Run only when this file is the entry point: `scripts/check.mjs` imports `build` from here.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof BuildError) {
      process.stderr.write(`build: ${error.message}\n`);
    } else {
      process.stderr.write(`build: ${error.stack ?? error}\n`);
    }
    process.exitCode = 1;
  });
}
