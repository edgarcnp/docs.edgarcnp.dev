/**
 * The reference page: one document, rendered at build time, served from the site root.
 *
 * `public/docs.json` is written first by `scripts/build.mjs` from `GET https://api.edgarcnp.dev/docs`,
 * so this reads the same contract the surface serves and cannot describe an endpoint the API's
 * router does not answer. Nothing renders at request time: the output is static HTML plus its
 * bundle, and the host serves it as assets.
 *
 * `baseUrl` is where the tree is *served*: `/` because the site is its own host, not a mount under
 * `/docs/ui`. Every link and asset URL in the output carries it.
 */
import { defineConfig, openapi } from "sourcey";

export default defineConfig({
  name: "api.edgarcnp.dev",
  siteUrl: "https://docs.edgarcnp.dev",
  baseUrl: "/",
  // The site owns its missing page: nothing sits behind it to answer one, and the host serves the
  // generated `404.html` with a 404 status for a path that matches no asset
  // (`assets.notFoundHandling: "404-page"` in `cloudflare.config.ts`).
  notFound: true,
  // No third-party font: the page then names one origin — this one — so the policy stays
  // `font-src 'self'` and a reader's browser makes no request any other origin has to allow. The
  // platform stack is what the text falls back to.
  theme: {
    name: "api-first",
    fonts: { sans: "system", google: false },
  },
  // Markdown views, `llms.txt` and a reference-preserving OpenAPI bundle are data a build would
  // have to keep in step for no reader here: the document is served at `/docs`, and the page is
  // the point.
  exports: { markdown: false, llms: false },
  // The console sends each request to the document's own `servers` entry, `https://api.edgarcnp.dev`,
  // so `connect-src` in `scripts/build.mjs` names that origin beside `'self'`. Reading a cross-origin
  // response is also the API's decision: it has to answer `Access-Control-Allow-Origin` for this
  // origin, and until it does the console reports the browser's refusal instead of a payload.
  tryIt: { credentials: "same-origin" },
  navigation: {
    tabs: [
      {
        tab: "API Reference",
        // The tab's own slug, so the page is the site's root: `/` answers it directly.
        slug: "",
        source: openapi("./public/docs.json"),
      },
    ],
  },
});
