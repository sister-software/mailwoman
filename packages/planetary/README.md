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

## Deployment

Each body is a Wrangler environment in `wrangler.toml` that names its Worker and its custom domain, so a deploy is a
build with the matching `PLANETARY_BODY` followed by `wrangler deploy --env <body>`; the custom domain and its
certificate are created from the file on the first deploy. With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
in the environment:

```bash
PLANETARY_BODY=moon yarn workspace @mailwoman/planetary build && yarn workspace @mailwoman/planetary wrangler deploy --env moon
PLANETARY_BODY=mars yarn workspace @mailwoman/planetary build && yarn workspace @mailwoman/planetary wrangler deploy --env mars
```

Deploying the wrong body to an environment is the one mistake the file cannot catch, which is why the app compares
its production hostname with its compiled body at startup and renders an error instead of the other world.

### On a push to main

`.github/workflows/deploy.yml` runs the same two commands per body when a push reaches this workspace or a
dependency of it. The reach is not a path list: `mwops release deploy-targets` maps the changed files to workspaces
and deploys a body when one of them lies in the app's dependency closure, walked from the manifests, or a root build
file changed. The Worker table the workflow deploys from is `packages/release-kit/lib/deploy/targets.ts`.
