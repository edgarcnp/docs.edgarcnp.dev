import { defineConfig } from "cf/config";

/**
 * The deployment: one Worker whose whole job is to serve the tree `node scripts/build.mjs` renders.
 *
 * `assets.notFoundHandling: "404-page"` is what makes the site own its missing page: a request that
 * matches no asset is answered with the nearest `404.html` and a `404` status, which is why the
 * build fails when the generator stops emitting one. `htmlHandling: "auto-trailing-slash"` maps a
 * path without an extension to the `.html` beside it, so the page's own `/404` link resolves.
 *
 * No entrypoint: nothing runs at request time. The assets are served before any Worker script would
 * be, and there is none — the response headers come from `_headers` in the tree (`scripts/build.mjs`
 * writes it with the page's style hash in it), never from code.
 */
export default defineConfig({
  worker: {
    name: "docs",

    // A compatibility date later than the current *UTC* date is rejected (error 10021), and "today"
    // on a UTC+7 machine can already be tomorrow in UTC: bump this to the UTC date of the deploy.
    compatibilityDate: "2026-11-04",

    // The custom domain is the Worker's only ingress. `workersDev` defaults to "on when there are
    // no routes", an implicit coupling that would flip if the domain below were removed, so it is
    // off explicitly.
    workersDev: false,
    domains: ["docs.edgarcnp.dev"],

    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
      runWorkerFirst: false,
    },
  },
});
