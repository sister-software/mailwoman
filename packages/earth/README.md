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
table the workflow deploys from is `packages/release-kit/lib/deploy/targets.ts`.

Two rules outside the repository decide whether a deployment works: the public bucket's CORS rule must admit the
origin the app is served from (`https://earth.mailwoman.ai` is admitted; a `*.workers.dev` preview origin is not), and
the tile worker's CORS list in `packages/tile-worker/lib/cors.ts` must name the same origin.
