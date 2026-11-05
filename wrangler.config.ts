import { defineWranglerConfig } from "wrangler/experimental-config";

/**
 * Build settings for the deployment.
 *
 * `assetsDirectory` is the whole of it: the deploy uploads `dist` as it stands, including the
 * `_headers` the build writes into it. The build is a separate step (`bun run build`, which
 * `bun run deploy` runs first) because a Worker with no entrypoint has nothing for Wrangler to
 * bundle — verified locally: `cf build` leaves `dist` untouched when `build.command` is set here,
 * so a command in this file would be a promise the deploy does not keep.
 */
export default defineWranglerConfig({
  assetsDirectory: "./dist",
});
