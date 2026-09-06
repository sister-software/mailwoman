# Earth: the geocoder map as a product at `earth.mailwoman.ai`

**Status:** design approved 2026-09-06. Decisions the operator took: the word "demo" is retired, the app lives
under `packages/`, the browser runtime moves into the packages that own it (no `@mailwoman/browser`), and
Cloudflare Workers Builds builds and deploys the app.
**Builds on:** `2026-09-06-browser-export-conditions-design.md` (the packages must bundle under Vite without
aliases before this app can consume them).
**Precedes:** `2026-09-06-planetary-app-design.md`, which copies this app's build and deployment shape.
**Supersedes:** the uploaded "Mailwoman Earth PWA" proposal (grounded on `05d029eba`, 864 commits behind
`c79757bdf`). The drift it carried is recorded at the end.

## The problem

The geocoder map at `mailwoman.ai/demo` is a browser application that happens to be a Docusaurus page. The
page and its runtime are 3,976 lines under `docs/src/pages/demo/` and `docs/src/shared/`, and they own the
model loader, the httpvfs resolvers, the range-cache service worker, the version-pin constants that
`mailwoman gazetteer publish` tells the operator to bump, and the runtime assembly in `_runtime.ts` (701
lines). Ten packages and scripts name a docs file as their canonical twin. `docs/package.json` carries
`onnxruntime-web`, `maplibre-gl`, `react-map-gl` and twelve `@mailwoman/*` runtime packages, and
`docs-build.yml` rebuilds and redeploys the whole site when any of nine packages change.

The result is that documentation is the integration test surface for the browser geocoder, and every
docs build problem (the disabled `rspack` bundler, the jiti loader rules, the `demo-assets` plugin) is
a runtime problem wearing a docs costume.

## Decisions taken

**Earth is a product, not a demo.** It ships at `earth.mailwoman.ai` beside `moon.mailwoman.ai` and
`mars.mailwoman.ai`. Every identifier that says "demo" is renamed at the moment it moves, to a name
that says what it is. "Fake runtime" stays as the test-fixture term in stories and tests.

**The app is a private workspace under `packages/`.** `packages/earth`, `@mailwoman/earth`,
`private: true`, in `SANCTIONED_RELEASE_ABSENCES` with the reason "private Earth map app — Cloudflare
infrastructure, never publishes". Every workspace lives under `packages/` except `docs/`, and an app is
a workspace with a `wrangler.toml`, not a new directory root.

**The runtime moves to its owners.** No new runtime package. The table below is the move map.

**Docusaurus keeps the components and loses the runtime.** Docs pages keep importing
`@mailwoman/react` and rendering the explainers (`ModelVisualizer`, `PipelineExplorer`,
`POIExplorer`, `DashboardMap`). What leaves is the geocoder page, the shared runtime modules, the plugin
that bundles them, and the dependencies that exist only for them. Docs under webpack and Earth under
Vite are then two independent bundler readings of every package both consume.

**Cloudflare builds it.** Workers Builds, connected to the repository, builds on push to `main` and
deploys with `wrangler deploy`. No publish workflow, no API token in GitHub, no Worker script: the
`wrangler.toml` declares `assets` and nothing else.

**Done includes the removal.** The work is not finished while any of the geocoder page, its runtime
modules, its plugin, its static assets, or its dependencies remain in `docs/`.

## Design

### Workspace

```text
packages/earth/
  package.json          @mailwoman/earth, private
  tsconfig.json         rootDir ./lib, include ./lib/**/*
  tsconfig.test.json
  vite.config.ts
  wrangler.toml         name, compatibility_date, [assets] directory = "./dist", not_found_handling = "single-page-application"
  index.html
  lib/
    main.tsx
    App.tsx
    config.ts           typed origins: dataOriginURL, tileWorkerURL, basemapTileJSONURL
    routes.ts           "/" | "/debug" | "/trace", and the ?q= reader
    resources.ts        the version pins that left docs/src/shared/resources/index.ts
    build-info.ts       reads the generated build.json
    panels/             the host-only UI moved from docs/src/pages/demo/_*.tsx
    styles/
  test/
  public/
    sqljs/              staged by the build from sql.js-httpvfs, as artifacts.ts does today
```

`wrangler.toml` has no `main`, no `run_worker_first`, no routes other than the custom domain. Static
Asset requests do not invoke a Worker.

### Build and deployment

Workers Builds configuration lives in the Cloudflare dashboard, so the spec records it here and the
package README repeats it:

| Setting           | Value                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root directory    | `packages/earth`                                                                                                                                                       |
| Build command     | `yarn build` (`tsc -b && vite build`, then the `build.json` emit)                                                                                                      |
| Deploy command    | `npx wrangler deploy`                                                                                                                                                  |
| Production branch | `main`                                                                                                                                                                 |
| Watch paths       | `packages/earth/**`, `packages/react/**`, `packages/neural/**`, `packages/resolver-wof-wasm/**`, `packages/core/**`, `packages/cartographer/**`, `packages/spatial/**` |

Yarn 4 locates the project root by walking up from the working directory, so `yarn install` from
`packages/earth` installs the workspace graph (LIKELY; the first build proves it, and the fallback is a
root directory of `.` with `yarn workspace @mailwoman/earth build`). The build never needs the
`neural-weights-*` binaries: the app fetches model and gazetteer artifacts from `public.mailwoman.ai` at
runtime, exactly as the docs page does.

`build.json` is generated by the build with `app`, `revision` (`gitHead()` from `@mailwoman/core/git`),
`buildTime` (`isoSeconds` from `@mailwoman/core/utils/time`), and the resource versions from
`resources.ts`. Production smoke fetches `/`, `/build.json`, `/manifest.webmanifest`, `/sqljs/sql-wasm.wasm`,
and one basemap tile.

### PWA

`vite-plugin-pwa` in `injectManifest` mode. The service worker source is the range-cache worker moved
from `docs/static/range-cache-sw.js` to `packages/earth/lib/service-worker.ts`, unchanged in behaviour
(persistence of validated 64 KB range chunks keyed by URL and offset, torn-chunk integrity), with the
app-shell precache manifest injected at build. Precache holds the shell, hashed JS/CSS, icons, the sqljs
runtime files, and the manifest. It never precaches a model, a gazetteer database, or a tile.

Manifest identity:

```json
{
	"id": "https://earth.mailwoman.ai/",
	"name": "Mailwoman Earth",
	"short_name": "Earth",
	"start_url": "/",
	"scope": "/",
	"display": "standalone"
}
```

### Routes

Three routes, read from `location.pathname` with no router: `/` is the geocoder, `/debug` is the same
page with the model visualizer open, `/trace` is the trace page that `docs/src/pages/trace.tsx` is today.
`?q=<address>` is preserved on all three. Cloudflare's SPA fallback serves `index.html` for each.

### The move map

Every row moves in its own PR, with tests travelling and the rename applied in the same change. No
compatibility re-export is left behind.

| From (`docs/src/…`)                                                                                                                              | To                                                                                                                                         | Renamed to                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `shared/httpvfs-resolver.ts` (749 lines)                                                                                                         | `@mailwoman/resolver-wof-wasm/httpvfs-resolver`                                                                                            | unchanged; the twin comments in `resolver-wof-sqlite` now name a package |
| `shared/candidate-resolver-backend.ts`                                                                                                           | `@mailwoman/resolver-wof-wasm/candidate-backend`                                                                                           |                                                                          |
| `shared/httpvfs-street.ts`                                                                                                                       | `@mailwoman/resolver-wof-wasm/httpvfs-street` (the geometry already lives in `@mailwoman/spatial/polyline`; only the I/O moves)            |                                                                          |
| `shared/poi-httpvfs.ts`                                                                                                                          | `@mailwoman/resolver-wof-wasm/poi-httpvfs`                                                                                                 |                                                                          |
| `shared/demo-loader.ts`                                                                                                                          | `@mailwoman/neural/web-loader` (merge; one loader)                                                                                         | `loadReleaseAssets`                                                      |
| `shared/demo-helpers.ts` (540 lines)                                                                                                             | `@mailwoman/resolver-wof-wasm/cascade` for `runCascade` and `flattenTree`; the rest to the app                                             | `demo-cascade-smoke.ts` imports the package instead of copying           |
| `shared/confidence-tiers.ts`                                                                                                                     | `@mailwoman/react/common/confidence-tiers` (`ConfidenceCell.tsx` already wants it)                                                         |                                                                          |
| `shared/resources/index.ts`                                                                                                                      | `packages/earth/lib/resources.ts`; `mailwoman gazetteer publish` prints this path                                                          |                                                                          |
| `shared/register-range-sw.ts`, `static/range-cache-sw.js`                                                                                        | `packages/earth/lib/service-worker.ts` and its registration                                                                                |                                                                          |
| `shared/maplibre-worker*.ts`, `sqljs-rows.ts`, `text-tokens.ts`                                                                                  | the app, or the package whose type they serve; decided per file at move time                                                               |                                                                          |
| `pages/demo/_runtime.ts` (701 lines)                                                                                                             | `@mailwoman/react/map/useGeocoderRuntime` over the existing `useDemoRuntime` orchestration hook, which becomes `useRuntime`                | `GeocoderRuntime`, `useGeocoderRuntime`                                  |
| `pages/demo/_map-helpers.ts`                                                                                                                     | constants to `packages/earth/lib/config.ts`; `fetchBasemapSource` and `loadPolygonDB` to `@mailwoman/cartographer` and `resolver-wof-wasm` |                                                                          |
| `pages/demo/_compare.tsx`, `_controls.tsx`, `_debug.tsx`, `_devDrawer.tsx`, `_mapControls.tsx`, `_hooks.tsx`, `index.tsx`, the three CSS modules | `packages/earth/lib/panels/`                                                                                                               |                                                                          |
| `components/AboutDemo`, `PermalinkButton`, `VersionCompare`, `LayerToggleControl`, `ResultPanel` (docs copy)                                     | the app; `ResultPanel` already exists in `@mailwoman/react/map`, so the docs copy is deleted                                               | `About`                                                                  |
| `pages/debug.tsx`, `pages/trace.tsx`                                                                                                             | the app's routes                                                                                                                           |                                                                          |
| `plugins/demo-assets/`                                                                                                                           | deleted; asset staging becomes a Vite build step in the app                                                                                |                                                                          |

Renames in `@mailwoman/react/map`, applied when `_runtime.ts` lands and the package's own tests are
touched: `GeocoderDemo` to `Geocoder`, `DemoMap` to `MapCanvas`, `DemoControls` to `GeocoderControls`,
`useDemoGeocode` to `useGeocode`, `DemoMapProps` and siblings accordingly, `DemoRuntime` to
`GeocoderRuntime`, `DemoPanels` to `GeocoderPanels`. Subpath exports (`./map/DemoMap`,
`./map/GeocoderDemo`, `./runtime/useDemoRuntime`) are renamed, not aliased.

### Docs after the move

- `docs/package.json` loses `onnxruntime-web`, `maplibre-gl`, `react-map-gl`, `sql.js-httpvfs`,
  `@mailwoman/neural`, `@mailwoman/resolver`, `@mailwoman/resolver-wof-sqlite`,
  `@mailwoman/resolver-wof-wasm`, `@mailwoman/cartographer`, `@mailwoman/kind-classifier`,
  `@mailwoman/phrase-grouper`, `@mailwoman/query-shape`. It keeps `@mailwoman/react`, `@mailwoman/core`
  and `@mailwoman/codex` for the explainers. If an explainer needs one of the removed packages, that
  explainer moves to the Earth app under `/debug`; a docs page links to it.
- `/demo`, `/debug` and `/trace` become redirects to `earth.mailwoman.ai` with the same path and query,
  through `@docusaurus/plugin-client-redirects` (not yet a docs dependency) or a static page with a
  `meta refresh` and a link, whichever preserves `?q=` in the docs build.
- `docs-build.yml` watch paths shrink to `docs/**`, `packages/react/**`, `packages/core/**`,
  `packages/codex/**`.
- The Vale scope and AGENTS.md lose their references to the geocoder page. AGENTS.md also drops the
  stale `apps/web-demo/` line; that directory was removed on 2026-08-21.

### Origins and CORS

`packages/tile-worker/lib/cors.ts` gains `https://earth.mailwoman.ai`, `https://moon.mailwoman.ai` and
`https://mars.mailwoman.ai`. `public.mailwoman.ai` is the R2 public origin and its CORS policy is
verified for the new origin before launch; the check is a `curl` with an `Origin` header against
`releases.json`, `wof-hot.db` (a `Range` request), and one model file, recorded in the launch PR.
Range behaviour does not change: the browser talks to `public.mailwoman.ai` directly, and no Worker sits
in that path.

### Testing

- `@mailwoman/react/map`: the fake-runtime component tests, stories and geometry tests stay. The
  runtime hook gets a test with injected loaders, no network.
- `@mailwoman/resolver-wof-wasm`: the moved httpvfs tests travel; the candidate-backend parity test
  (browser versus `candidate-lookup.ts`) keeps its rows.
- `packages/earth`: route and query parsing, `build.json` shape, a Vite production build in CI, and a
  Playwright smoke over the fake runtime: shell loads, `Geocoder` renders, a fake query completes,
  `/debug` opens the visualizer, `?q=` survives.
- Production smoke after each deploy, against real assets: `/`, `/build.json`, the manifest, the sqljs
  WASM, a `Range` request to `public.mailwoman.ai`, a tile from `tiles.mailwoman.ai`.

## Definition of done

- `earth.mailwoman.ai` serves the geocoder on the real runtime with parity on: version manifest,
  classifier load, WOF resolver, FST autocomplete, street resolution, postcode anchors, basemap,
  polygon overlays, map bias, device-location bias, calibrator, compare mode, debug trace.
- `?q=` links from before the move resolve on the new host through the docs redirect.
- **The geocoder is completely removed from Docusaurus:** `docs/src/pages/demo/`, `docs/src/pages/debug.tsx`,
  `docs/src/pages/trace.tsx`, `docs/src/shared/`, `docs/plugins/demo-assets/`, `docs/static/range-cache-sw.js`,
  the staged `docs/static/mailwoman/` assets, and the twelve dependencies above are gone from `docs/`.
  `grep -rn "docs/src/shared" packages` returns zero lines, and the twin comments in
  `resolver-wof-sqlite`, `spatial/polyline.ts`, `demo-cascade-smoke.ts`, `data/bundles.ts` and
  `gazetteer/publish.tsx` name their package or app.
- No identifier exported from `@mailwoman/react`, `@mailwoman/neural` or `@mailwoman/resolver-wof-wasm`
  contains "demo", except the fake-runtime test fixtures.
- The docs site builds with `rspackBundler` retried and the result recorded.
- `packages/earth` is registered in the root `workspaces`, both root `tsconfig.json` reference entries,
  and `SANCTIONED_RELEASE_ABSENCES`; the `publishCount` pin in `release-stage.test.ts` is unchanged.
- The Workers Builds project exists, deploys from `main`, and the README carries its settings table.

## Out of scope

Redesigning the geocoder's appearance, the resolver, or the model. A generated release manifest in place
of `resources.ts` (the version pins move as constants first; the manifest is a follow-up). A Worker
script of any kind. Any planetary data.

## Drift from the uploaded proposal

Recorded so nobody re-reads the proposal as current.

| Proposal                                                    | Checkout at `c79757bdf`                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/earth`, `apps/web-demo` status to decide              | `apps/` was removed 2026-08-21 (`9d22f6fe6`); every workspace is under `packages/`     |
| `@mailwoman/browser` new package                            | refused; owning-package export conditions                                              |
| `tiles.sister.software`, `public.sister.software`           | `tiles.mailwoman.ai`, `public.mailwoman.ai`                                            |
| `wrangler.jsonc`                                            | the repository's workers use `wrangler.toml`                                           |
| `packages/react/map/DemoMap.tsx`                            | `packages/react/lib/map/DemoMap.tsx`; source is under `lib/` everywhere                |
| `scripts/publish-demo-assets-to-r2.py` bumps docs constants | `mailwoman gazetteer publish` prints the bump instruction                              |
| `/demo` and `/debug` only                                   | `/trace` also exists                                                                   |
| `httpvfs-street` is a hand-kept twin                        | the geometry is already shared through `@mailwoman/spatial/polyline`; only I/O remains |
| GitHub Actions deploy with wrangler                         | Workers Builds from the dashboard                                                      |
