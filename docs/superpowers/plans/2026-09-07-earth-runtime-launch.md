# Earth Runtime Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/earth` runs the real browser geocoder with parity to today's docs page, the "demo" names in `@mailwoman/react/map` become product names, the browser test suite moves to the app, the docs site redirects `/demo`, `/debug` and `/trace` to `earth.mailwoman.ai`, and the geocoder page, its runtime assembly, its service worker and its dependencies leave `docs/`. Done includes the removal.

**Architecture:** The runtime assembly (`_runtime.ts`, the basemap and polygon helpers, the geolocation hook, the range-cache registration) becomes application code under `packages/earth/lib/runtime/`, consuming the package homes the first runtime plan created. The service worker gains the range cache. The host panels and the two live explainers (`ModelVisualizer`, `LiveModelVisualizer`) move to the app with `/debug` and `/trace`. The docs keep `DemoEmbed` (renamed `RuntimeEmbed`) for the explainers that stay, the maplibre worker staging for `DashboardMap`, and the sql.js staging for the explainers that resolve. The Playwright suite moves with the page and its fixtures; `demo-smoke.yml` targets the new host.

**Tech Stack:** as the shell plan; the docs Docusaurus build for the retirement proof; knip for the dependency trim.

**Spec:** `docs/superpowers/specs/2026-09-06-earth-app-design.md` (Routes, PWA, The move map's application rows, Docs after the move, Origins and CORS, Testing, Definition of done).

## Global Constraints

- Lands after the shell plan and the runtime-homes plan; rebase onto both.
- A moved or renamed name gets no compatibility re-export.
- Behaviour parity, not redesign: the seven browser specs that pass on the docs page pass on the app, on the real assets, before the docs page is retired.
- `packages/earth` never imports `@mailwoman/docs` or `docs/**`; `packages/**` never imports `@mailwoman/docs`.
- Docs keep working after every task: `cd docs && yarn build` exits 0.
- `process.env` never read directly; `node:*` only under `core/lib/fs`.
- Comments state invariants; the migration goes in commits.
- Branch: `git fetch origin main && git checkout -b feat/earth-runtime-launch origin/main`.

## Rename map (`@mailwoman/react/map`)

| Old                                                                                                | New                                                                                                 | Old subpath                | New subpath                   |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------- |
| `GeocoderDemo`                                                                                     | `Geocoder`                                                                                          | `./map/GeocoderDemo`       | `./map/Geocoder`              |
| `DemoMap`                                                                                          | `MapCanvas`                                                                                         | `./map/DemoMap`            | `./map/MapCanvas`             |
| `DemoControls`                                                                                     | `GeocoderControls`                                                                                  | (barrel)                   | (barrel)                      |
| `useDemoGeocode`                                                                                   | `useGeocode`                                                                                        | (barrel)                   | (barrel)                      |
| `DemoRuntime`                                                                                      | `GeocoderRuntime`                                                                                   | `./map/types`              | `./map/types`                 |
| `DemoPanels`                                                                                       | `GeocoderPanels`                                                                                    | `./map/types`              | `./map/types`                 |
| `DemoMapStyle`                                                                                     | `MapCanvasStyle`                                                                                    | `./map/types`              | `./map/types`                 |
| `DemoVersionOption`                                                                                | `VersionOption`                                                                                     | `./map/types`              | `./map/types`                 |
| `DemoBackend`                                                                                      | `InferenceBackend`                                                                                  | `./map/types`              | `./map/types`                 |
| `DemoCompareContext`                                                                               | `CompareContext`                                                                                    | `./map/types`              | `./map/types`                 |
| `DemoResultContext`                                                                                | `ResultContext`                                                                                     | `./map/types`              | `./map/types`                 |
| `useDemoRuntime`                                                                                   | `useReleaseRuntime`                                                                                 | `./runtime/useDemoRuntime` | `./runtime/useReleaseRuntime` |
| `DemoManifest`, `DemoReleaseBase`, `DemoRuntimeConfig`, `DemoLoaderState`, `DemoAssetsLoadContext` | `ReleaseManifest`, `ReleaseBase`, `ReleaseRuntimeConfig`, `ReleaseLoaderState`, `AssetsLoadContext` | (barrel)                   | (barrel)                      |
| `makeDemoRuntime`                                                                                  | `makeFakeGeocoderRuntime`                                                                           | `./map/fake-runtime`       | `./map/fake-runtime`          |

"Fake runtime" stays the fixture term. `PipelineExplorer`, `POIExplorer` and their runtime names carry no "demo" and stay.

---

### Task 1: The runtime assembly moves into the app

**Files:**

- Move: `docs/src/pages/demo/_runtime.ts` → `packages/earth/lib/runtime/use-geocoder-runtime.ts`; `docs/src/pages/demo/_hooks.tsx` → `packages/earth/lib/runtime/use-browser-geolocation.ts`; `docs/src/pages/demo/_map-helpers.ts` → `packages/earth/lib/runtime/basemap.ts`; `docs/src/shared/register-range-sw.ts` → `packages/earth/lib/runtime/range-cache.ts`; `docs/static/range-cache-sw.js` → merged into `packages/earth/lib/service-worker.ts`
- Create: `packages/site-kit/lib/vite/stage-sqljs.ts`
- Modify: `packages/earth/lib/App.tsx`, `packages/earth/lib/config.ts`, `packages/earth/vite.config.ts`, `packages/earth/package.json` (dependencies), `packages/earth/tsconfig.json` (references)

**Interfaces:**

- Consumes: `mailwoman/browser-runtime/{load-assets,manifest,classify,resources,types}`, `@mailwoman/resolver-wof-wasm/httpvfs/{resolver,street}`, `@mailwoman/resolver-wof-wasm/browser-cascade`, `@mailwoman/cartographer/base`, `@mailwoman/cartographer/coverage`, `@mailwoman/react` (`useReleaseRuntime` after Task 4; `useDemoRuntime` until then), `@mailwoman/spatial`.
- Produces: `useGeocoderRuntime(options: { config: EarthConfig; initialCenter; forceWASM… })` returning what `useDemoMapRuntime` returns today (`runtime`, `releases`, `forceWASM`, `geoBias`, `calibrator`, `traceParse`, `supportsTrace`); `useBrowserGeolocation(config)`; `registerRangeCacheServiceWorker()` and `pruneDBRangeCache(keepVersion)` against the app's own worker; `stageSQLJSPlugin(destDir)`.

- [ ] **Step 1: Move the four files and rewrite their imports**

```bash
mkdir -p packages/earth/lib/runtime
git mv docs/src/pages/demo/_runtime.ts       packages/earth/lib/runtime/use-geocoder-runtime.ts
git mv docs/src/pages/demo/_hooks.tsx        packages/earth/lib/runtime/use-browser-geolocation.ts
git mv docs/src/pages/demo/_map-helpers.ts   packages/earth/lib/runtime/basemap.ts
git mv docs/src/shared/register-range-sw.ts  packages/earth/lib/runtime/range-cache.ts
```

In `use-geocoder-runtime.ts`: `#shared/demo-helpers` → `mailwoman/browser-runtime/classify` or `…/manifest` by name; `#shared/demo-loader` → `mailwoman/browser-runtime/load-assets` (`loadReleaseAssets(release, ctx, { gazetteer: { sqljsBaseURL } })`); `#shared/httpvfs-street` → `@mailwoman/resolver-wof-wasm/httpvfs/street`; `#shared/register-range-sw` → `#runtime/range-cache`; `#shared/resources` → `mailwoman/browser-runtime/resources` or `…/types`; `./_map-helpers.ts` → `#runtime/basemap`. Rename `useDemoMapRuntime` → `useGeocoderRuntime`, `UseDemoMapRuntime` → `GeocoderRuntimeHandle`, `UseDemoMapRuntimeOptions` → `GeocoderRuntimeOptions`. The `sqljsBaseURL` option is replaced by the app's `EarthConfig`: add `sqljsBaseURL: "/sqljs"` to `PRODUCTION_CONFIG` (the app serves the staged files at that path; Task 1 Step 3).

In `basemap.ts`: delete `TILE_WORKER_URL` and `BASEMAP_TILEJSON_URL` (they are `EarthConfig.tileWorkerURL` and `basemapTileJSONURL`); delete `fetchBasemapSource` and its caller composes `{ type: "vector", url: String(config.basemapTileJSONURL) }` instead, which is what MapLibre does with a TileJSON URL (cartographer's race-dots source is the precedent); `loadPolygonDB` imports `loadHTTPVFSDatabase` and `makeHTTPVFSPolygonLookup` from `@mailwoman/resolver-wof-wasm/httpvfs/resolver`. In `use-browser-geolocation.ts`: the `/geolocate` URL composes from `config.tileWorkerURL`. In `range-cache.ts`: the worker URL is the app's own `/sw.js` (vite-plugin-pwa registers it; the range-cache module only posts the prune message to `navigator.serviceWorker.ready`), so `registerRangeCacheServiceWorker(baseURL)` becomes a no-op removed in favour of `registerSW()` in `main.tsx`, and only `pruneDBRangeCache` stays.

Read each moved file's header and rewrite the sentences that name Docusaurus, `/demo` or "docs-side".

- [ ] **Step 2: The service worker gains the range cache**

Append the body of `docs/static/range-cache-sw.js` (the `fetch` handler with the 64 KB chunk persistence and torn-chunk check, the `message` handler for `mailwoman-prune-db-ranges`, `CACHE_NAME`) to `packages/earth/lib/service-worker.ts` below `precacheAndRoute`, typed (`self.addEventListener("fetch", …)` with `FetchEvent`), then `git rm docs/static/range-cache-sw.js`. The header paragraph of the old file, which explains the protocol, comes with it. `docs/src/contexts/DemoEmbed.tsx` still imported `registerRangeCacheServiceWorker` and `pruneDBRangeCache`: the docs explainers that resolve keep the range cache too, so the docs get their own copy of the worker? No: the docs' WOF reads are the explainers' and small; drop the range cache from docs (delete the two calls in `DemoEmbed.tsx`), which is a documented behaviour change for the docs explainers only (a repeat visit re-fetches chunks) and none for the app.

- [ ] **Step 3: sql.js assets under the app**

`packages/site-kit/lib/vite/stage-sqljs.ts`:

```ts
import { stageSQLJSAssets } from "@mailwoman/resolver-wof-wasm/host-assets"
import type { Plugin } from "vite"

/**
 * Stage sql.js-httpvfs's runtime files into the app's public directory before Vite builds or serves, so the httpvfs
 * readers find them at `/sqljs/`. The files are never bundled (they are loaded by URL at run time).
 */
export function stageSQLJSPlugin(destDir: string): Plugin {
	return {
		name: "mailwoman-stage-sqljs",
		async buildStart() {
			if (!(await stageSQLJSAssets(destDir))) throw new Error("sql.js-httpvfs runtime files could not be staged")
		},
	}
}
```

`packages/earth/vite.config.ts` adds `stageSQLJSPlugin("public/sqljs")`; `packages/earth/.gitignore` gets `public/sqljs/`. `site-kit`'s dependencies gain `@mailwoman/resolver-wof-wasm`. MapLibre's worker: `main.tsx` imports `maplibre-gl/dist/maplibre-gl-csp-worker?url` and calls `maplibregl.setWorkerUrl(url)` before the first map mounts, the same setting `docs/src/shared/maplibre-worker.ts` makes with a staged copy; under Vite the `?url` import is the staged copy.

- [ ] **Step 4: The app mounts the real runtime**

`App.tsx` replaces `makeDemoRuntime()` with:

```tsx
const initialCenter = useBrowserGeolocation(PRODUCTION_CONFIG)
const { runtime, releases, forceWASM, geoBias, calibrator, traceParse, supportsTrace } = useGeocoderRuntime({
	config: PRODUCTION_CONFIG,
	initialCenter: initialCenter ?? DEFAULT_CENTER,
})
```

Render the map immediately at `DEFAULT_CENTER` and let the geolocation answer move the bias, which is the spec's non-blocking rule; `DEFAULT_CENTER` is the contiguous-US centre the hook already carries. The fake runtime stays reachable behind `?runtime=fake` for the shell smoke and Storybook parity, read in `routes.ts` as `runtimeModeFromSearch(search): "real" | "fake"` with a unit test.

- [ ] **Step 5: Build and run the real thing**

```bash
yarn compile
yarn workspace @mailwoman/earth build > /tmp/earth-build.log 2>&1; echo "EXIT=$?" >> /tmp/earth-build.log; grep -n "EXIT=\|node:\|externalized" /tmp/earth-build.log
yarn workspace @mailwoman/earth preview
```

Open `http://localhost:7780/?q=Chicago,%20IL`: the model loads from `public.mailwoman.ai`, the query resolves to the Chicago locality with a marker. A Vite "externalized for browser compatibility" warning names a `node:` specifier on the static graph; `yarn mwops health bundle-graph` says which package, and the fix is a condition there, not an alias here.

```bash
git add packages/earth packages/site-kit docs
git commit -m "feat(earth): the real geocoder runtime is application code; the service worker carries the range cache"
```

---

### Task 2: The host panels and the two live explainers

**Files:**

- Move: `docs/src/pages/demo/{_compare,_controls,_debug,_devDrawer,_mapControls}.tsx`, `styles.module.css`, `geocoder.module.css`, `_debug.module.css` → `packages/earth/lib/panels/`; `docs/src/components/{AboutDemo,PermalinkButton,VersionCompare,LayerToggleControl}/` → `packages/earth/lib/panels/<name>/`; `docs/src/components/ModelVisualizer/` (both visualizers, styles, helpers) and `docs/src/components/DashboardMap/map-debug.ts` → `packages/earth/lib/explorers/`; the docs tests of those components (`grep -rl "components/ModelVisualizer\|VersionCompare\|LayerToggleControl" docs/test/unit`) → `packages/earth/test/unit/`
- Delete: `docs/src/components/ResultPanel/` (the app uses `@mailwoman/react/map`'s `ResultPanel`; if the docs copy renders something the react one does not, that difference moves into the react component as a prop, once)
- Modify: `packages/earth/lib/App.tsx` (the `panels` composition from `docs/src/pages/demo/index.tsx` lines 35–108), `packages/earth/lib/routes.ts` (`/debug` opens the drawer; `/trace` mounts `LiveModelVisualizer`)

- [ ] **Step 1: Move, rename, rewire**

```bash
mkdir -p packages/earth/lib/panels packages/earth/lib/explorers
git mv docs/src/pages/demo/_compare.tsx      packages/earth/lib/panels/Compare.tsx
git mv docs/src/pages/demo/_controls.tsx     packages/earth/lib/panels/Controls.tsx
git mv docs/src/pages/demo/_devDrawer.tsx    packages/earth/lib/panels/DebugDrawer.tsx
git mv docs/src/pages/demo/_debug.tsx        packages/earth/lib/panels/MapDebug.tsx
git mv docs/src/pages/demo/_mapControls.tsx  packages/earth/lib/panels/MapControls.tsx
git mv docs/src/pages/demo/styles.module.css packages/earth/lib/panels/panels.module.css
git mv docs/src/pages/demo/geocoder.module.css packages/earth/lib/panels/geocoder.module.css
git mv docs/src/pages/demo/_debug.module.css packages/earth/lib/panels/map-debug.module.css
git mv docs/src/components/AboutDemo         packages/earth/lib/panels/About
git mv docs/src/components/PermalinkButton   packages/earth/lib/panels/PermalinkButton
git mv docs/src/components/VersionCompare    packages/earth/lib/panels/VersionCompare
git mv docs/src/components/LayerToggleControl packages/earth/lib/panels/LayerToggleControl
git mv docs/src/components/ModelVisualizer   packages/earth/lib/explorers/ModelVisualizer
git mv docs/src/components/DashboardMap/map-debug.ts packages/earth/lib/explorers/map-debug.ts
git rm -r docs/src/components/ResultPanel
```

`AboutDemo` → `About` (the component and its file). A `@docusaurus/BrowserOnly` wrapper is deleted (the whole app is client-side); `@theme/CodeBlock` becomes a `<pre><code>`; `@site/…` and `#components/…` imports become `#panels/…` or `@mailwoman/react`; `#shared/…` imports follow the runtime-homes plan's map; `#contexts/DemoEmbed` in `ModelVisualizer` becomes the app's runtime handle (`traceParse` from `useGeocoderRuntime`, passed as a prop). `VersionCompare` imported `SpanHighlight` and `TimingPanel` from docs components: both render a parse result and stay useful to docs pages, so they move to `@mailwoman/react/pipeline` (`SpanHighlight`, `TimingPanel`) with exports, and both hosts import them. `DashboardMap/DashboardMap.tsx` in docs imported `map-debug.ts` from its own folder; if it did, `map-debug.ts` moves to `@mailwoman/react/map/map-debug` instead of the app, since two hosts read it.

- [ ] **Step 2: Compose the panels in the app**

The `panels` object from `docs/src/pages/demo/index.tsx` (header `<About/>`, `releaseInfo`, `bias` `<GeoBiasRow/>`, `permalink`, `aboveResult` with `CalibrationToggle` and `DevModeToggle`, `result` with `ResultPanel` and the `DebugDrawer`, `mapControls`, `compare`) moves into `packages/earth/lib/App.tsx` verbatim, with `debugDefault = route === Route.Debug`. The `/trace` route renders `<LiveModelVisualizer traceParse={traceParse} />` in place of the geocoder. Delete `docs/src/pages/debug.tsx` and `docs/src/pages/trace.tsx` now; Task 6 puts redirects in their place.

- [ ] **Step 3: Build, look at all three routes, commit**

```bash
yarn compile && yarn workspace @mailwoman/earth build && yarn workspace @mailwoman/earth preview
cd docs && yarn build > /tmp/docs-build.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build.log; tail -2 /tmp/docs-build.log; cd -
```

`/`, `/debug` (drawer open), `/trace` (the visualizer) each render on the real runtime; the docs build exits 0 without the page (its route is gone until Task 6's redirect). Commit:

```bash
git add packages/earth packages/react docs
git commit -m "feat(earth): the host panels and the live explainers are application code; /debug and /trace are routes"
```

---

### Task 3: The browser suite moves to the app

**Files:**

- Move: `docs/test/browser/*.spec.ts` (10 files) → `packages/earth/test/browser/`; `docs/test/e2e/{index.ts,fixtures/,utils/}` → `packages/earth/test/e2e/`
- Modify: `packages/earth/test/e2e/fixtures/DemoFixture.ts` (paths), `docs/playwright.config.ts` (only the `build` project remains), `docs/package.json` (`#e2e` imports), `.github/workflows/demo-smoke.yml`, `packages/earth/package.json` (`imports["#e2e/*"]`)

- [ ] **Step 1: Move and repoint**

```bash
mkdir -p packages/earth/test/browser packages/earth/test/e2e
git mv docs/test/browser/*.spec.ts packages/earth/test/browser/
git mv docs/test/e2e/index.ts docs/test/e2e/fixtures docs/test/e2e/utils packages/earth/test/e2e/
```

`DemoFixture.ts` → `GeocoderFixture.ts` with the class renamed; its `goto` builds `/?q=…` instead of `/demo?q=…`; the `sqljs` expectations name `/sqljs/`. The specs import `#e2e` through the app's `imports` map (add `"#e2e": "./test/e2e/index.ts"` and `"#e2e/*": "./test/e2e/*"` to `packages/earth/package.json`, the entries `docs/package.json` carries today, and remove them from docs). `packages/earth/test/browser/shell.spec.ts` from the shell plan appends `?runtime=fake` to its `goto` calls. `docs/playwright.config.ts` keeps only the `build` project and its `test/build` dir; drop the `chromium` project and the webServer, since the browser specs are gone.

- [ ] **Step 2: The smoke workflow**

`.github/workflows/demo-smoke.yml` → `earth-smoke.yml`: `MAILWOMAN_EARTH_URL: ${{ inputs.earth_url || 'https://earth.mailwoman.ai' }}`, `working-directory: packages/earth`, `yarn playwright install chromium`, `yarn test:browser --grep @smoke`. `yarn mwops health no-root-scripts` reads the workflow; run it.

- [ ] **Step 3: Run the seven parity specs on the app, on the real assets**

```bash
yarn workspace @mailwoman/earth test:browser test/browser/100-demo-cold-load.spec.ts test/browser/200-demo-resolve.spec.ts
yarn workspace @mailwoman/earth test:browser
```

Expected: 7 of 7, then the full suite green (the cold-load spec's action timeout is 30 s; a timeout on a cold model load is timing, and a second run separates it from a failure). Commit:

```bash
git add packages/earth docs .github/workflows
git commit -m "test(earth): the browser suite and its fixtures run against the app; the smoke workflow targets earth.mailwoman.ai"
```

---

### Task 4: The renames

**Files:**

- Modify: every file under `packages/react/lib/map`, `packages/react/lib/runtime`, `packages/react/lib/index.ts`, `packages/react/package.json` (subpaths), `packages/react/test`, `packages/react/lib/**/*.stories.tsx`, `packages/earth/lib`, `docs/src/contexts/DemoEmbed.tsx` → `RuntimeEmbed.tsx`, docs components that import a renamed name

- [ ] **Step 1: Rename files and symbols in react**

```bash
cd packages/react/lib/map
git mv GeocoderDemo.tsx Geocoder.tsx; git mv GeocoderDemo.stories.tsx Geocoder.stories.tsx
git mv DemoMap.tsx MapCanvas.tsx; git mv DemoMap.stories.tsx MapCanvas.stories.tsx
git mv DemoControls.tsx GeocoderControls.tsx
git mv useDemoGeocode.ts useGeocode.ts
cd ../runtime && git mv useDemoRuntime.ts useReleaseRuntime.ts && git mv useDemoRuntime.stories.tsx useReleaseRuntime.stories.tsx && cd ../../../..
git mv packages/react/test/unit/map/GeocoderDemo.test.tsx packages/react/test/unit/map/Geocoder.test.tsx
```

Then apply the rename map with word-boundary substitutions across the listed trees:

```bash
FILES=$(grep -rlE "GeocoderDemo|DemoMap|DemoControls|useDemoGeocode|DemoRuntime|DemoPanels|DemoMapStyle|DemoVersionOption|DemoBackend|DemoCompareContext|DemoResultContext|useDemoRuntime|DemoManifest|DemoReleaseBase|DemoRuntimeConfig|DemoLoaderState|DemoAssetsLoadContext|makeDemoRuntime" packages/react packages/earth docs/src --include='*.ts' --include='*.tsx' --include='*.json' | grep -v "/out/")
sed -i -E 's/\bGeocoderDemoProps\b/GeocoderProps/g; s/\bGeocoderDemo\b/Geocoder/g; s/\bDemoMapExtraProps\b/MapCanvasExtraProps/g; s/\bDemoMapProps\b/MapCanvasProps/g; s/\bDemoMapStyle\b/MapCanvasStyle/g; s/\bDemoMap\b/MapCanvas/g; s/\bDemoControlsProps\b/GeocoderControlsProps/g; s/\bDemoControls\b/GeocoderControls/g; s/\bUseDemoGeocodeOptions\b/UseGeocodeOptions/g; s/\bUseDemoGeocode\b/UseGeocode/g; s/\buseDemoGeocode\b/useGeocode/g; s/\bDemoRuntimeConfig\b/ReleaseRuntimeConfig/g; s/\bDemoRuntime\b/GeocoderRuntime/g; s/\bDemoPanels\b/GeocoderPanels/g; s/\bDemoVersionOption\b/VersionOption/g; s/\bDemoBackend\b/InferenceBackend/g; s/\bDemoCompareContext\b/CompareContext/g; s/\bDemoResultContext\b/ResultContext/g; s/\buseDemoRuntime\b/useReleaseRuntime/g; s/\bDemoManifest\b/ReleaseManifest/g; s/\bDemoReleaseBase\b/ReleaseBase/g; s/\bDemoLoaderState\b/ReleaseLoaderState/g; s/\bDemoAssetsLoadContext\b/AssetsLoadContext/g; s/\bmakeDemoRuntime\b/makeFakeGeocoderRuntime/g; s#map/GeocoderDemo#map/Geocoder#g; s#map/DemoMap#map/MapCanvas#g; s#runtime/useDemoRuntime#runtime/useReleaseRuntime#g' $FILES
```

`ReleaseManifest` collides with `mailwoman/browser-runtime/manifest`'s `ReleaseManifest` (the wire manifest) where a file imports both; in that file the react one is the generic `ReleaseManifest<TRelease>` and the browser-runtime one is the concrete wire type, so import the wire one as `WireReleasesManifest` there, and rename the browser-runtime export to `ReleasesManifest` (plural, its name in docs before the move) to keep them apart. Run `grep -rn "Demo" packages/react/lib packages/earth/lib --include='*.ts' --include='*.tsx' | grep -v "fake\|Fake"` afterwards; what remains must be prose that says "demo" of something that is a demo, and the stories' titles (`"Map/Geocoder"`).

- [ ] **Step 2: Verify and commit**

```bash
yarn compile
yarn workspace @mailwoman/react test:browser
yarn workspace @mailwoman/react build-storybook > /tmp/sb.log 2>&1; echo "EXIT=$?" >> /tmp/sb.log; tail -1 /tmp/sb.log
yarn workspace @mailwoman/earth build
cd docs && yarn typecheck && cd -
yarn mwops health exports manifest-targets
git add packages/react packages/earth docs
git commit -m "refactor(react,earth,docs): the geocoder surface is named for what it is — Geocoder, MapCanvas, GeocoderRuntime, useReleaseRuntime"
```

---

### Task 5: The tile worker origin and the production deployment check

- [ ] **Step 1: CORS is already in place from the shell plan; verify against production data**

```bash
for u in https://public.mailwoman.ai/mailwoman/en-us/releases.json https://tiles.mailwoman.ai/basemap-v4.json; do curl -sI -H "Origin: https://earth.mailwoman.ai" "$u" | grep -i "access-control-allow-origin\|^HTTP" | tr -d '\r'; done
curl -sI -H "Origin: https://earth.mailwoman.ai" -H "Range: bytes=0-65535" "https://public.mailwoman.ai/mailwoman/wof-hot/$(node -e "console.log(require('./packages/mailwoman/out/browser-runtime/resources.js').ADMIN_GAZETTEER_VERSION)")/wof-hot.db" | grep -i "^HTTP\|content-range\|access-control" | tr -d '\r'
```

Expected: `200`/`206` and an `Access-Control-Allow-Origin` echoing the origin (or `*` from the public bucket). A missing header on `public.mailwoman.ai` is a bucket CORS rule the operator sets in the Cloudflare dashboard; record it in the PR as the second dashboard step and do not proceed to Task 6 until it is in place.

- [ ] **Step 2: Deploy and smoke**

The Workers Builds project from the shell plan deploys `main` on merge; before merging, a preview build (`wrangler versions upload` on the branch, or the dashboard's preview) at the preview URL runs:

```bash
MAILWOMAN_EARTH_URL=https://<preview>.workers.dev yarn workspace @mailwoman/earth test:browser --grep @smoke
```

Expected: pass on the real deployment. The parity list from the spec's definition of done (version manifest, classifier, WOF resolver, FST autocomplete, street resolution, postcode anchors, basemap, polygon overlays, map bias, device-location bias, calibrator, compare mode, debug trace) is what the ten moved specs cover; name in the PR any item no spec covers and check it by hand in the preview.

---

### Task 6: The docs retire the page

**Files:**

- Create: `docs/src/pages/demo/index.tsx` (redirect), `docs/src/pages/debug.tsx` (redirect), `docs/src/pages/trace.tsx` (redirect)
- Rename: `docs/src/contexts/DemoEmbed.tsx` → `RuntimeEmbed.tsx` (`useRuntimeEmbed`, `RuntimeEmbedProvider`); `docs/plugins/demo-assets/` → `docs/plugins/runtime-assets/`
- Modify: `docs/docusaurus.config.ts` (navbar and footer `/demo` → `https://earth.mailwoman.ai`, the plugin path, sitemap ignore patterns), `docs/package.json` (dependencies per knip, `imports["#shared/*"]` and `#e2e` gone), `.github/workflows/docs-build.yml` (paths), `docs/.gitignore` (the staged-asset entries that remain), `AGENTS.md` (the `apps/web-demo` line; the docs row; the `demo-assets` mention in the fs bullet if any)
- Delete: whatever remains under `docs/src/shared/` except `maplibre-worker.ts` and `maplibre-worker-url.ts`; `docs/test/unit/plugins/demo-assets/` moves with the plugin rename

- [ ] **Step 1: The redirects**

Docusaurus deploys to GitHub Pages, which serves no server-side redirect, so each retired route is a page that forwards on the client and keeps the query:

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The geocoder lives at earth.mailwoman.ai. This page forwards a visitor there with their query intact, and shows
 *   the link for a client that does not run the script.
 */

import Head from "@docusaurus/Head"
import Layout from "@theme/Layout"
import { useEffect } from "react"

const EARTH = "https://earth.mailwoman.ai"

export default function DemoRedirect() {
	useEffect(() => {
		location.replace(`${EARTH}/${location.search}`)
	}, [])

	return (
		<Layout title="Earth">
			<Head>
				<meta httpEquiv="refresh" content={`0;url=${EARTH}/`} />
				<link rel="canonical" href={`${EARTH}/`} />
			</Head>
			<main style={{ padding: "2rem" }}>
				<p>
					The geocoder has moved to <a href={`${EARTH}/`}>earth.mailwoman.ai</a>.
				</p>
			</main>
		</Layout>
	)
}
```

`debug.tsx` and `trace.tsx` forward to `${EARTH}/debug` and `${EARTH}/trace` with the same shape; the three share one component in `docs/src/components/EarthRedirect/EarthRedirect.tsx` taking `path`, so the shape is written once. The `meta refresh` covers the no-script case; `location.replace` keeps the query, which `meta refresh` cannot.

- [ ] **Step 2: Config, plugin, dependencies**

`docusaurus.config.ts`: the navbar CTA and the footer item point at `https://earth.mailwoman.ai`; the `demo-assets` plugin path becomes `runtime-assets`; the sitemap ignore patterns keep `/debug` and `/trace` (they are redirect pages) and add `/demo`. `docs/plugins/runtime-assets/plugin.ts` keeps the maplibre worker staging (for `DashboardMap`), the sql.js staging through `stageSQLJSAssets` (for the explainers that resolve), the workspace aliases, and the SSR policy; `stagePairIndexes` goes if nothing in docs reads a pair index any more (`grep -rn "pair-index" docs/src`). Then:

```bash
yarn install
yarn mwops health exports > /tmp/knip.log 2>&1; grep -n "docs" /tmp/knip.log
```

Remove every docs dependency knip names as unused; re-run until it names none. The spec predicted `onnxruntime-web`, `maplibre-gl`, `react-map-gl`, `sql.js-httpvfs` and twelve `@mailwoman/*` packages; the measurement decides, and `maplibre-gl`, `react-map-gl` and `@mailwoman/cartographer` stay for `DashboardMap`, `@mailwoman/neural` stays for the visualizer types the explainers keep, and `sql.js-httpvfs` stays for staging unless `resolver-wof-wasm/host-assets` resolves it through its own dependency (it does; drop it from docs).

- [ ] **Step 3: Workflows, AGENTS, ignore files**

`.github/workflows/docs-build.yml` `push.paths`: `docs/**`, `packages/react/**`, `packages/core/**`, `packages/codex/**`, `packages/cartographer/**`, `packages/neural/**`, `mailwoman` if the explainers import `mailwoman/browser-runtime` (they do: `RuntimeEmbed` loads through it) — the list is the set of packages a docs import reaches, measured by `grep -rhoE 'from "(@mailwoman/[a-z-]+|mailwoman)' docs/src | sort -u`. `AGENTS.md`: delete the `apps/web-demo/` bullet under the non-workspace directories; the `docs/` row says "Docusaurus site → https://mailwoman.ai. Prose, the explainers, links to earth, moon and mars"; add rows for `packages/earth`, `packages/site-kit` (and the planetary rows land with their plans); the fs bullet's mention of the browser bundle's shim policy, if any, goes. `docs/.gitignore` keeps `/static/mailwoman/sqljs/` and `/static/mailwoman/maplibre/`, drops the `pair-index` entry if staging went.

- [ ] **Step 4: The proofs**

```bash
ls docs/src/shared docs/src/pages docs/src/pages/demo
grep -rn "docs/src/shared\|@mailwoman/docs" packages --include='*.ts' --include='*.tsx' | grep -v "/out/"
grep -rn "\"demo\"" docs/docusaurus.config.ts
cd docs && yarn build > /tmp/docs-build.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build.log; grep -n "^EXIT=\|Broken" /tmp/docs-build.log; yarn test:e2e --project=build; cd -
yarn workspace @mailwoman/docs typecheck
```

Expected: `docs/src/shared` holds the two maplibre files; `pages/demo/index.tsx`, `pages/debug.tsx`, `pages/trace.tsx` are the redirects; the grep over `packages` prints nothing; the docs build exits 0 with no broken link (the pages that linked `/demo` still resolve to the redirect page); the `build` Playwright project passes.

- [ ] **Step 5: Commit**

```bash
git add docs AGENTS.md .github/workflows/docs-build.yml
git commit -m "chore(docs): the geocoder leaves Docusaurus — redirects to earth.mailwoman.ai, the runtime-assets plugin keeps only what the explainers need, dependencies by knip"
```

---

### Task 7: Preflight, spec receipts, PR

- [ ] **Step 1: Preflight**

```bash
yarn compile
yarn health > /tmp/health.log 2>&1; echo "EXIT=$?" >> /tmp/health.log; grep -n "✗\|error:\|EXIT=" /tmp/health.log | head
yarn typecheck:tests
yarn ci:test:fast > /tmp/fast.log 2>&1; echo "EXIT=$?" >> /tmp/fast.log; grep -E "Tests |Test Files|EXIT=" /tmp/fast.log
yarn workspace @mailwoman/react test:browser
yarn workspace @mailwoman/earth test:browser
yarn mwops release smoke-clean-install 2>&1 | tail -3
```

The last command runs because `mailwoman` gained subpaths in the runtime-homes plan and `react` gained a dependency: a clean install of the published shape must still resolve them.

- [ ] **Step 2: The spec's definition of done, checked line by line**

In `docs/superpowers/specs/2026-09-06-earth-app-design.md`, "Definition of done": every bullet gets a one-line receipt (the command or spec that proves it) in the status line's paragraph; the removal bullet's grep is the one in Task 6 Step 4. The "Docs after the move" dependency list is replaced by what knip measured. Append to the status line: `Launched <date> (PR #<n>); the Workers Builds project and the public bucket's CORS rule are the two dashboard steps the operator took.`

- [ ] **Step 3: PR**

```bash
git push -u origin feat/earth-runtime-launch
gh pr create --title "Earth runtime, part 2: the real geocoder at earth.mailwoman.ai; the docs retire the page" --body-file - <<'EOF'
Implements the application rows of docs/superpowers/specs/2026-09-06-earth-app-design.md by docs/superpowers/plans/2026-09-07-earth-runtime-launch.md.

- packages/earth runs the real runtime (assembly, panels, the two live explainers, the range cache in its service worker, sql.js staged by site-kit through resolver-wof-wasm/host-assets); /, /debug, /trace; ?runtime=fake keeps the fixture reachable
- @mailwoman/react/map renamed for what it is: Geocoder, MapCanvas, GeocoderControls, useGeocode, GeocoderRuntime, GeocoderPanels, useReleaseRuntime, makeFakeGeocoderRuntime; no compatibility re-exports
- the ten browser specs and their fixtures run against the app; earth-smoke.yml targets earth.mailwoman.ai
- docs: /demo, /debug, /trace redirect with the query intact; the runtime-assets plugin keeps only what the explainers need; dependencies trimmed by knip; docs/src/shared holds the two maplibre files only

Parity: the seven specs of 100-demo-cold-load and 200-demo-resolve pass on the preview deployment; <list any hand-checked item>.

Dashboard steps taken by the operator: the Workers Builds project (shell plan) and the public bucket's CORS rule for the three origins.

https://claude.ai/code/session_01ADYjzV88cHb94MRW4Dn1Aq
EOF
```
