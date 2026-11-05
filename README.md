# docs.edgarcnp.dev

The API's reference site: one static page, generated at build time from the API's own OpenAPI
document, served at **https://docs.edgarcnp.dev** by a Cloudflare Worker with static assets.

It replaces the reference tree the API binary embeds and serves at `https://api.edgarcnp.dev/docs/ui`.
The API keeps serving that tree until this site passes its acceptance checks; removing it there is a
separate change in that repository, which this one never touches.

## The contract with the API

`GET https://api.edgarcnp.dev/docs` returns the document as `application/json`, generated from the
service's routing table and served with `Cache-Control: public, max-age=0, must-revalidate` and an
`ETag`. `info.version` is the deployed crate version, and the page displays it.

The page is rendered from that document on every build. An endpoint that appears there appears on the
page with no change in this repository. There is no other interface between the two repositories.

## Requirements

- **Bun 1.4.4** — the package manager (`packageManager` in `package.json`; `bunfig.toml` makes every
  install an exact pin).
- **Node 26.13.0 on `PATH`.** `node_modules/.bin/sourcey` is `#!/usr/bin/env node`, and `bun run`
  honours that shebang instead of replacing it, so the generator runs on Node even though Bun
  installed it. The Cloudflare CLI starts the same way. A host with Bun but no Node fails the build.
  CI pins the version in `.github/actions/setup-node/action.yml`; `.nvmrc`-style files are not read
  by anything here.

## Commands

| Command | What it does |
| --- | --- |
| `bun install --frozen-lockfile` | Installs Sourcey and the Cloudflare CLI at their exact pins. |
| `bun run build` | Fetches the document, renders `dist`, computes the policy's style hash. |
| `bun run check` | The acceptance checks a checkout can answer: determinism, policy, subresources, 404, metadata, caching, growth. |
| `bun run live-check` | The same checks against the deployed site, after a deploy. |
| `bun run dev` | Builds once, then serves with Sourcey's dev server (Vite, live reload). |
| `bun run serve` | Serves the built `dist` as the Worker does, `_headers` and 404 included. Default port 4401. |
| `bun run deploy` | Builds, then uploads `dist` with `cf deploy`. Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. |

`bun run dev` renders with Vite, so the page it answers loads its client from `/node_modules/…?v=…`
and a `ws://…?token=…`, and neither URL exists in production. `bun run serve` answers from `dist` as
it stands and applies `dist/_headers`: the built policy with its style hash, the immutable asset
rules, the tree's own `404.html` for a miss, `/404` answering `404.html`, `ETag` and `304`, and the
asset layer's default `cache-control` where no rule names one. The browser then sees the deployed
URLs and the deployed policy — the difference between "the dev page works" and "the shipped page
works". It renders nothing and watches nothing: rebuild and reload.

## What the build does

`scripts/build.mjs`:

1. **Fetches `GET /docs`** and fails on a non-200, on a body that is not UTF-8 JSON, on an `openapi`
   that is not 3.x, on a document without `paths`, and on one without `info.version`. A page rendered
   from a stale or truncated document is worse than no deploy.
2. **Writes `public/docs.json`**, the path `sourcey.config.ts` reads, whole or not at all.
3. **Renders into `.build/site`**, never over `dist`. Sourcey writes content-addressed directories
   (`_assets/<hash>/`, `_search/<hash>/`) and removes nothing, so a build over an old tree leaves the
   previous hash beside the new one. Rendering beside the live tree also means a failed build leaves
   the last good site intact.
4. **Writes `_headers`** with the Content-Security-Policy, its `style-src` naming the `sha256-` of the
   emitted inline `<style>` block, and fails when a block cannot be read. A stale hash is a page
   whose styles the browser silently blocks.
5. **Replaces `dist`** — only a tree that carries Sourcey's own `.sourcey-output.json` is replaced.

`public/`, `dist/` and `.build/` are generated and git-ignored: nothing in the repository is edited by
hand on the way out.

## Headers

The site owns its headers, so it loses the API's unless it says them again. `scripts/build.mjs` writes
`_headers` at the deploy root, and Workers applies it to static-asset responses:

- `/*` — `nosniff`, `DENY` framing, `no-referrer`, `same-origin` resource policy, HSTS, and the policy.
- `/_assets/*`, `/_search/*`, `/_media/*`, `/_og/*` — `cache-control: … immutable`, because their
  paths carry a content hash.
- `/index.html` — `must-revalidate`; Workers' default for an asset is already that.

The `/*` block deliberately carries **no** `cache-control`: Workers gives a request every rule it
matches, and a header applied twice is joined with a comma, so a root-level `cache-control` would end
up appended to the asset rules and defeat the `immutable` ones.

The policy names one other origin, in `connect-src` only: `https://api.edgarcnp.dev`, the console's
target. Every other directive names this origin alone — `style-src` carries a hash rather than
`'unsafe-inline'`, and `img-src` is `'self' data: blob:`, because the API's `https://edgarcnp.dev`
allowance was for its avatar and nothing in this tree loads it.

## Deployment

- `cloudflare.config.ts` — the Worker: name `docs`, the custom domain `docs.edgarcnp.dev`,
  `workersDev: false`, and `assets.notFoundHandling: "404-page"` so a path matching no asset is
  answered with the generated `404.html` and a `404` status.
- `wrangler.config.ts` — `assetsDirectory: "./dist"`, and nothing else. A Worker with no entrypoint
  has nothing for Wrangler to bundle, so a `build.command` there would never run: the build is a step
  of its own, and `bun run deploy` runs it before `cf deploy` uploads the directory as it stands.
- `.github/workflows/ci.yml` — on push to `main` and on every pull request: build, checks, and
  `cf deploy --dry-run` (which validates the deployment without uploading or a credential).
- `.github/workflows/deploy.yml` — on a `v*` tag: the CI workflow must pass on the tagged commit, the
  commit must be an ancestor of `main`, the tag must equal `package.json`'s `version`, and the deploy
  is followed by `bun run live-check` against the custom domain.

### Before the first deploy

- **`CLOUDFLARE_API_TOKEN`** and **`CLOUDFLARE_ACCOUNT_ID`** as repository secrets. The token needs
  `Workers Scripts:Edit` on the account, and attaching `docs.edgarcnp.dev` as a custom domain also
  touches the zone, so give it `Workers Routes:Edit` on `edgarcnp.dev`. The API repository already
  deploys a Worker with a custom domain in that zone from a token, so a token minted the same way works
  here; a deploy that lacks a scope fails naming the permission it wanted.
- **The `edgarcnp.dev` zone in that account**, and **`docs.edgarcnp.dev` free**: a custom domain cannot
  be attached to two Workers or to a Pages project at once.
- **A `v*` tag on a commit of `main`** that matches `package.json`'s `version` (`v1.0.1` today). The
  deploy job refuses anything else.
- Nothing else: no buckets, no KV, no bindings, no build-time secrets. The document is fetched over the
  public internet at build time.

The first deploy can outrun DNS: `bun run live-check` retries the first request for 30 seconds, and if
the domain is still resolving elsewhere, re-running that step is the fix.

`compatibilityDate` in `cloudflare.config.ts` must not be later than the current **UTC** date
(Cloudflare rejects it with error 10021), so bump it to the UTC date of the deploy.

## The acceptance checks

| Check | Where it runs |
| --- | --- |
| Clean install and build with Bun **and** Node | CI, and any checkout |
| Two builds byte-identical | `bun run check` |
| Every subresource is this origin and answers | `bun run check` (tree), `bun run live-check` (deployed) |
| The policy validates and the style hash matches the served block | `bun run check`, `bun run live-check` |
| `og:image` and `sitemap.xml` absolute against the site | `bun run check`, `bun run live-check` |
| An unknown path answers the site's own 404 | `bun run check` (the page exists), `bun run live-check` (the host serves it with 404) |
| The page's version is the document's, and a new operation appears after a rebuild | `bun run check` |
| `_assets/**` immutable, `/index.html` revalidating | `bun run check` (the rules), `bun run live-check` (the response) |

## Decisions

- **`notFound: true`.** It makes Sourcey emit `404.html`, which `notFoundHandling: "404-page"`
  serves. Verified by building: the tree carries the generated page, titled `Page not found`.
- **The console is on** (`tryIt: { credentials: "same-origin" }`), and `connect-src` names the API's
  origin for it. The console also needs the API to allow this origin, and today it does not: with
  either `Origin: https://docs.edgarcnp.dev` or `Origin: http://localhost:4401` the API answers `200`
  carrying no `access-control-*` header, and answers `403` to a preflight `OPTIONS`. The browser then
  discards the response and the console says *"The browser could not complete this request…"* — a CORS
  refusal, not a connectivity problem. What the API has to answer, for both origins and for `OPTIONS`
  before the request: `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Methods`,
  `Access-Control-Allow-Headers: content-type`, and `Vary: Origin`. That change belongs to the API
  repository; nothing in this one can grant it.
- **`img-src` tightened** to `'self' data: blob:`, because no file in the tree references
  `https://edgarcnp.dev`.
- **The Worker is named `docs`**, and `docs.edgarcnp.dev` is its only ingress.
