# @mailwoman/planetary

Planetary is one app built twice, as `https://moon.mailwoman.ai` and `https://mars.mailwoman.ai`. Each build is an
installable PWA on Cloudflare Workers Static Assets. The app is static. `wrangler.toml` declares `assets` and no Worker
script, so a navigation or an asset request never invokes compute. The globe draws the body's nomenclature and hillshade
archives from `tiles.mailwoman.ai`, and search runs in the browser over the ancestrie artifact the astrogeology
pipeline published to `public.mailwoman.ai`.

## The body is a build-time value

`PLANETARY_BODY` (`moon` or `mars`) is read once, under Node, by `vite.config.ts` through the package's env
(`lib/env.ts`), and compiled into the client as `__PLANETARY_BODY__`. A build with no value or an unknown one fails
with the schema's message. The body selects its config in `lib/bodies/`, its icon set in `public/icons/<body>/`, and
its PWA identity, so the two installations stay distinct. At startup the app compares the production hostname with
its body. When a project serves the wrong build, the app renders an error instead of the other world.

## Commands

| Command                                                                | Does                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `PLANETARY_BODY=moon yarn workspace @mailwoman/planetary dev`          | Vite dev server on port 7791                                    |
| `PLANETARY_BODY=moon yarn workspace @mailwoman/planetary build`        | `dist/`, with `build.json`, the manifest and the service worker |
| `yarn workspace @mailwoman/planetary preview`                          | serves `dist/` on port 7770 with SPA fallback                   |
| `PLANETARY_BODY=mars yarn workspace @mailwoman/planetary test:browser` | the Playwright smoke over a fresh build and the preview server  |
| `yarn workspace @mailwoman/planetary deploy:dry-run`                   | validates `wrangler.toml` and the asset manifest                |

The preview serves on port 7770. It is the only local origin that the public data bucket's CORS rule admits, and the
Earth preview uses the same port. On any other port the browser refuses the glyph and search-artifact fetches, so
labels never draw and search never loads. The smoke test fetches the published archives, so it needs the network.
`MAILWOMAN_PLANETARY_URL` points it at a deployment instead of the preview server.

## Routes

`/` is the globe. `/feature/<id>` is the globe with one named feature selected, where the id is the pipeline's
stable feature id from the USGS gazetteer. A click pushes the path, and a deep link restores the feature from the
search artifact. `?lon=&lat=&z=` sets the opening viewport. Any other path shows the not-found view.

## The artifact pin

Each body config in `lib/bodies/` pins one astrogeology publish by its build version (`YYYYMMDD-<digest>`). The
version identifies the search artifact and the manifest under `public.mailwoman.ai/planetary/<body>/<version>/`. The
tilesets on `tiles.mailwoman.ai` are unversioned, and each publish replaces them in place. When
`astrogeology publish` prints a new version, update the pin in a commit here. The attribution line reads the
manifest, so the snapshot date follows the pin without a second edit.

## Deployment

Each body is a Wrangler environment in `wrangler.toml` that declares its Worker and its custom domain. A deploy is
therefore a build with the matching `PLANETARY_BODY` followed by `wrangler deploy --env <body>`. The first deploy
creates the custom domain and its certificate from the file. With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
in the environment, run:

```bash
PLANETARY_BODY=moon yarn workspace @mailwoman/planetary build && yarn workspace @mailwoman/planetary wrangler deploy --env moon
PLANETARY_BODY=mars yarn workspace @mailwoman/planetary build && yarn workspace @mailwoman/planetary wrangler deploy --env mars
```

The file cannot catch a deploy of the wrong body to an environment. For that reason the app compares its production
hostname with its compiled body at startup and renders an error instead of the other world.

### On a push to main

`.github/workflows/deploy.yml` runs the same two commands per body when a push changes this workspace or one of its
dependencies. The workflow does not use a path list. `mwops release deploy-targets` maps the changed files to
workspaces. It deploys a body when one of those workspaces lies in the app's dependency closure, computed from the
manifests, or when a root build file changed. The Worker table the workflow deploys from is `packages/release-kit/lib/deploy/targets.ts`.
