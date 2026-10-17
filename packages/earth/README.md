# @mailwoman/earth

Earth is the mailwoman geocoder map, served at `https://earth.mailwoman.ai` as an installable PWA on Cloudflare
Workers Static Assets. The app is static: `wrangler.toml` declares `assets` and no Worker script, so a navigation or
an asset request never invokes compute. Model and gazetteer artifacts come from `public.mailwoman.ai` at run time
and tiles from `tiles.mailwoman.ai`; the range worker and sqlite-wasm runtime files are staged under `public/sqlite/` by the build.

## Commands

| Command                                          | Does                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `yarn workspace @mailwoman/earth dev`            | Vite dev server                                                             |
| `yarn workspace @mailwoman/earth build`          | `dist/`, with `build.json`, the manifest, the service worker and `sqlite/`  |
| `yarn workspace @mailwoman/earth preview`        | serves `dist/` on port 7771 with SPA fallback                               |
| `yarn workspace @mailwoman/earth test:browser`   | the Playwright suite over the preview server, or over `MAILWOMAN_EARTH_URL` |
| `yarn workspace @mailwoman/earth deploy:dry-run` | validates `wrangler.toml` and the asset manifest                            |

The preview serves on port 7771, and the public data bucket's CORS rule must admit `http://localhost:7771`. On a port
the rule does not admit, the browser refuses every model, gazetteer and sprite fetch and the geocoder never becomes
ready. The docs dev server holds port 7770.

### What the build reads

The Earth and planetary Vite builds consume the compiled `out/` rather than `lib/`, so an edit under
`lib/` reaches the bundle only after `tsc -b`. The shared Playwright config at `lib/site-kit/playwright.ts`
(repository root) sets `reuseExistingServer: !CI`, so a preview server already listening is reused and
`yarn build` never runs. `vite preview` serves `dist/` from disk on each request, so a rebuilt `dist/` is
served without restarting the server. Falsify a browser test as `tsc -b`, then `yarn build`, then the run,
and confirm that the hash of `dist/assets/index-*.js` changed before trusting a pass or a fail.

## Routes

`/` is the geocoder, `/debug` the same page with the decode-path drawer open, `/trace` the live model visualizer.
`?q=<address>` pre-fills the query on all three, and `?runtime=fake` mounts the canned runtime the shell smoke uses,
with no model download. Cloudflare's SPA fallback serves `index.html` for each, and the app reads `location.pathname`.

## Layout

- `lib/runtime/`: the runtime assembly over `mailwoman/browser-runtime` (`useGeocoderRuntime`), the geolocation hook,
  the polygon opener, and the range-cache protocol the service worker speaks. `lib/runtime/use/geocoder-runtime.ts`
  builds the classify deps object field by field from the browser loader's output rather than spreading it, and every
  classify dep is optional. A new field returned by `packages/mailwoman/lib/browser-runtime/load-assets.ts` therefore
  reaches the app only when this file forwards it. TypeScript does not report the omission, and no Node test exercises
  the file. After adding a browser-runtime asset, grep for a sibling field such as `selectPairIndex:` across
  `packages/earth` and `docs/src`, add the new field at each site, and run a headless parse that depends on the asset
  before declaring a repoint done.
- `lib/panels/`: the host chrome around `@mailwoman/react/map`'s geocoder (the compare panel, the controls, the
  drawer, the map controls, the layer toggle, the feature inspector, the version compare).
- `lib/explorers/`: the model visualizer and its live wrapper for `/trace`.
- `lib/service-worker.ts`: the precache and the range-chunk cache for the byte-range databases.
- `test/browser/`: the Playwright suite; `test/e2e/`: its fixtures.

## Deployment

`wrangler.toml` names the Worker and its custom domain, so a deploy is a build followed by `wrangler deploy`; the
custom domain and its certificate are created from the file on the first deploy. With `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment:

```bash
yarn workspace @mailwoman/earth build && yarn workspace @mailwoman/earth wrangler deploy
```

### On a push to main

`.github/workflows/deploy.yml` runs the same two commands when a push reaches this workspace or a dependency of it.
The reach is not a path list: `mwops release deploy-targets` maps the changed files to workspaces and deploys the app
when one of them lies in its dependency closure, walked from the manifests, or a root build file changed. The Worker
table the workflow deploys from is `lib/release-kit/deploy/targets.ts`.

Two rules outside the repository decide whether a deployment works: the public bucket's CORS rule must admit the
origin the app is served from (`https://earth.mailwoman.ai` is admitted, but a `*.workers.dev` preview origin is not), and
the tile worker's CORS list in `packages/tile-worker/lib/cors.ts` must name the same origin.
