# @mailwoman/planetary

Planetary is one app built twice: `https://moon.mailwoman.ai` and `https://mars.mailwoman.ai`, each an installable
PWA on Cloudflare Workers Static Assets. The app is static: `wrangler.toml` declares `assets` and no Worker script, so
a navigation or an asset request never invokes compute. The globe draws the body's nomenclature and hillshade
archives from `tiles.mailwoman.ai`, and search runs in the browser over the ancestrie artifact the astrogeology
pipeline published to `public.mailwoman.ai`.

## The body is a build-time value

`PLANETARY_BODY` (`moon` or `mars`) is read once, under Node, by `vite.config.ts` through the package's env
(`lib/env.ts`), and compiled into the client as `__PLANETARY_BODY__`. A build with no value or an unknown one fails
with the schema's message. The body selects its config in `lib/bodies/`, its icon set in `public/icons/<body>/`, and
its PWA identity, so the two installations stay distinct. At startup the app compares the production hostname with
its body and renders an error rather than the other world when a project serves the wrong build.

## Commands

| Command                                                                | Does                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `PLANETARY_BODY=moon yarn workspace @mailwoman/planetary dev`          | Vite dev server on port 7791                                    |
| `PLANETARY_BODY=moon yarn workspace @mailwoman/planetary build`        | `dist/`, with `build.json`, the manifest and the service worker |
| `yarn workspace @mailwoman/planetary preview`                          | serves `dist/` on port 7770 with SPA fallback                   |
| `PLANETARY_BODY=mars yarn workspace @mailwoman/planetary test:browser` | the Playwright smoke over a fresh build and the preview server  |
| `yarn workspace @mailwoman/planetary deploy:dry-run`                   | validates `wrangler.toml` and the asset manifest                |

The preview serves on port 7770, the one local origin the public data bucket's CORS rule admits and the port the
Earth preview uses too; on any other port the browser refuses the glyph and search-artifact fetches, so labels never
draw and search never loads. The smoke reaches the published archives, so it needs the network.
`MAILWOMAN_PLANETARY_URL` points it at a deployment instead of the preview server.

## Routes

`/` is the globe. `/feature/<id>` is the globe with one named feature selected, where the id is the pipeline's
stable feature id from the USGS gazetteer; a click pushes the path and a deep link restores the feature from the
search artifact. `?lon=&lat=&z=` sets the opening viewport. Any other path is the not-found view.

## The artifact pin

Each body config in `lib/bodies/` pins one astrogeology publish by its build version (`YYYYMMDD-<digest>`), which
names the search artifact and the manifest under `public.mailwoman.ai/planetary/<body>/<version>/`. The tilesets on
`tiles.mailwoman.ai` are unversioned and are replaced in place by a publish. When `astrogeology publish` prints a new
version, move the pin by a commit here; the attribution line reads the manifest, so the snapshot date follows the
pin without a second edit.

## Deployment: Workers Builds

Two Cloudflare projects build and deploy this workspace from the repository, one per body; the settings live in the
Cloudflare dashboard, not here.

| Setting           | Moon                                                                                                                                                                      | Mars                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Project name      | `mailwoman-moon`                                                                                                                                                          | `mailwoman-mars`                            |
| Root directory    | `packages/planetary`                                                                                                                                                      | `packages/planetary`                        |
| Build variable    | `PLANETARY_BODY=moon`                                                                                                                                                     | `PLANETARY_BODY=mars`                       |
| Build command     | `yarn build`                                                                                                                                                              | `yarn build`                                |
| Deploy command    | `npx wrangler deploy --name mailwoman-moon`                                                                                                                               | `npx wrangler deploy --name mailwoman-mars` |
| Custom domain     | `moon.mailwoman.ai`                                                                                                                                                       | `mars.mailwoman.ai`                         |
| Production branch | `main`                                                                                                                                                                    | `main`                                      |
| Watch paths       | `packages/planetary/**`, `packages/site-kit/**`, `packages/react/**`, `packages/cartographer/**`, `packages/astrogeology/**`, `packages/ancestrie/**`, `packages/core/**` | the same                                    |

The dashboard's project name overrides the `name` in `wrangler.toml`, which is why one file serves both projects.
