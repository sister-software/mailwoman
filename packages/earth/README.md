# @mailwoman/earth

Earth is the mailwoman geocoder map, served at `https://earth.mailwoman.ai` as an installable PWA on Cloudflare
Workers Static Assets. The app is static: `wrangler.toml` declares `assets` and no Worker script, so a navigation or
an asset request never invokes compute. Model and gazetteer artifacts come from `public.mailwoman.ai` at run time
and tiles from `tiles.mailwoman.ai`; the sql.js-httpvfs runtime files are staged under `public/sqljs/` by the build.

## Commands

| Command                                          | Does                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `yarn workspace @mailwoman/earth dev`            | Vite dev server                                                             |
| `yarn workspace @mailwoman/earth build`          | `dist/`, with `build.json`, the manifest, the service worker and `sqljs/`   |
| `yarn workspace @mailwoman/earth preview`        | serves `dist/` on port 7770 with SPA fallback                               |
| `yarn workspace @mailwoman/earth test:browser`   | the Playwright suite over the preview server, or over `MAILWOMAN_EARTH_URL` |
| `yarn workspace @mailwoman/earth deploy:dry-run` | validates `wrangler.toml` and the asset manifest                            |

The preview serves on port 7770 because that is the local origin the public data bucket's CORS rule admits; on any
other port the browser refuses every model, gazetteer and sprite fetch and the geocoder never becomes ready.

## Routes

`/` is the geocoder, `/debug` the same page with the decode-path drawer open, `/trace` the live model visualizer.
`?q=<address>` pre-fills the query on all three, and `?runtime=fake` mounts the canned runtime the shell smoke uses,
with no model download. Cloudflare's SPA fallback serves `index.html` for each; the app reads `location.pathname`.

## Layout

- `lib/runtime/`: the runtime assembly over `mailwoman/browser-runtime` (`useGeocoderRuntime`), the geolocation hook,
  the polygon opener, and the range-cache protocol the service worker speaks.
- `lib/panels/`: the host chrome around `@mailwoman/react/map`'s geocoder (the compare panel, the controls, the
  drawer, the map controls, the layer toggle, the feature inspector, the version compare).
- `lib/explorers/`: the model visualizer and its live wrapper for `/trace`.
- `lib/service-worker.ts`: the precache and the range-chunk cache for the byte-range databases.
- `test/browser/`: the Playwright suite; `test/e2e/`: its fixtures.

## Deployment: Workers Builds

Cloudflare builds and deploys this app from the repository; the settings live in the Cloudflare dashboard, not here.

| Setting           | Value                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root directory    | `packages/earth`                                                                                                                                                                                                        |
| Build command     | `yarn build`                                                                                                                                                                                                            |
| Deploy command    | `npx wrangler deploy`                                                                                                                                                                                                   |
| Production branch | `main`                                                                                                                                                                                                                  |
| Watch paths       | `packages/earth/**`, `packages/site-kit/**`, `packages/react/**`, `packages/core/**`, `packages/mailwoman/**`, `packages/neural/**`, `packages/resolver-wof-wasm/**`, `packages/cartographer/**`, `packages/spatial/**` |

Yarn locates the project root by walking up from the root directory, so the install covers the workspace graph. If the
first build shows it does not, set the root directory to `.` and the build command to
`yarn workspace @mailwoman/earth build`, and point the wrangler configuration path at `packages/earth/wrangler.toml`.

Two rules outside the repository decide whether a deployment works: the public bucket's CORS rule must admit the
origin the app is served from (`https://earth.mailwoman.ai` is admitted; a `*.workers.dev` preview origin is not), and
the tile worker's CORS list in `packages/tile-worker/lib/cors.ts` must name the same origin.
