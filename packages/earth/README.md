# @mailwoman/earth

Earth is the mailwoman geocoder map, served at `https://earth.mailwoman.ai` as an installable PWA on Cloudflare
Workers Static Assets. The app is static: `wrangler.toml` declares `assets` and no Worker script, so a navigation or
an asset request never invokes compute. Model and gazetteer artifacts come from `public.mailwoman.ai` at run time
and tiles from `tiles.mailwoman.ai`.

## Commands

| Command                                          | Does                                                            |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `yarn workspace @mailwoman/earth dev`            | Vite dev server                                                 |
| `yarn workspace @mailwoman/earth build`          | `dist/`, with `build.json`, the manifest and the service worker |
| `yarn workspace @mailwoman/earth preview`        | serves `dist/` on port 7780 with SPA fallback                   |
| `yarn workspace @mailwoman/earth test:browser`   | the Playwright smoke over the preview server                    |
| `yarn workspace @mailwoman/earth deploy:dry-run` | validates `wrangler.toml` and the asset manifest                |

## Routes

`/` is the geocoder, `/debug` the same page with the debug drawer open, `/trace` the trace page. `?q=<address>`
pre-fills the query on all three. Cloudflare's SPA fallback serves `index.html` for each; the app reads
`location.pathname`.

## Deployment: Workers Builds

Cloudflare builds and deploys this app from the repository; the settings live in the Cloudflare dashboard, not here.

| Setting           | Value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| Root directory    | `packages/earth`                                                                     |
| Build command     | `yarn build`                                                                         |
| Deploy command    | `npx wrangler deploy`                                                                |
| Production branch | `main`                                                                               |
| Watch paths       | `packages/earth/**`, `packages/site-kit/**`, `packages/react/**`, `packages/core/**` |

Yarn locates the project root by walking up from the root directory, so the install covers the workspace graph. If the
first build shows it does not, set the root directory to `.` and the build command to
`yarn workspace @mailwoman/earth build`, and point the wrangler configuration path at `packages/earth/wrangler.toml`.

The watch paths grow when the runtime moves in (`neural`, `resolver-wof-wasm`, `cartographer`, `spatial`).
