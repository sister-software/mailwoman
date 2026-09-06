# Planetary App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One private workspace, `packages/planetary`, built twice by `PLANETARY_BODY`, serving `moon.mailwoman.ai` and `mars.mailwoman.ai`: a MapLibre globe over the published nomenclature and hillshade archives, labels decluttered by scale, a click-to-inspect feature panel, search over the pipeline's ancestrie artifact, stable `/feature/<id>` links, and visible attribution from the pipeline manifest.

**Architecture:** The app copies the Earth shell's shape and imports the shared pieces from `@mailwoman/site-kit`. `@mailwoman/cartographer` gains a `planetary` module whose `createPlanetaryStyle` composes a body's sources and layers over `StyleSpecificationComposer`, which learns to take its base layers, hillshade source and sprite as inputs instead of assuming Earth's. Sources are TileJSON URLs on `tiles.mailwoman.ai`, which MapLibre resolves itself. The body is fixed at build through the package's own `lib/env.ts` and Vite `define`; the production host is checked against it at startup. Feature identity is the pipeline's stable id, carried in tile properties and the search payload, so a deep link needs no tile query.

**Tech Stack:** React 19, Vite 8, `react-map-gl` 8 over MapLibre 6 (`projection: "globe"`), `@mailwoman/ancestrie` reader, `vite-plugin-pwa`, wrangler 4, Playwright, vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-planetary-app-design.md`

## Global Constraints

- Lands after the Earth shell plan (`site-kit`, the fake-runtime subpath) and the astrogeology plan (the archives, the search artifact, the manifest). Rebase onto both.
- `packages/planetary`, `@mailwoman/planetary`, `private: true`; registers: root `workspaces` (after `packages/photon`, before `packages/poi-taxonomy`), both root `tsconfig.json` entries, `SANCTIONED_RELEASE_ABSENCES` ("private planetary map app — Cloudflare infrastructure, never publishes"), the dependency-cruiser browser list.
- `PLANETARY_BODY` is read once, at build, through `packages/planetary/lib/env.ts` (a `liveEnv` view over `@mailwoman/core/env`), never `process.env`; the client sees it through Vite `define` as `__PLANETARY_BODY__`.
- No Earth basemap layer, no sprite, no Worker script, no query-parameter body switch.
- Every distance or area claim goes through `@mailwoman/spatial` with the body; v1 makes none.
- Dependency ranges match existing declarations (`sherif`).
- The component and hook names are the ones the second Earth runtime plan leaves in `@mailwoman/react/map` (`MapCanvas`); if that plan has not landed, `DemoMap` is the same component under its old name, and the rename touches this app's two import lines when it lands.
- Branch: `git fetch origin main && git checkout -b feat/planetary origin/main`.

## File Structure

```text
packages/planetary/
  package.json, tsconfig.json, tsconfig.test.json, README.md
  vite.config.ts            react(), installablePWA(identity for the body), buildInfoPlugin({ app }), define __PLANETARY_BODY__
  wrangler.toml             assets only; the Workers project name comes from the dashboard per body
  playwright.config.ts      previewConfig({ port: 7790, remoteURLVariable: "MAILWOMAN_PLANETARY_URL" })
  index.html
  public/icons/{moon,mars}/ icon.svg, icon-192.png, icon-512.png; vite copies the body's set to /
  lib/
    env.ts                  PLANETARY_BODY (node-side, build)
    body.ts                 currentBody(): the build-time body; assertHostMatchesBody(hostname)   (tested)
    bodies/{index,moon,mars}.ts  PlanetaryMapConfig per body                                       (tested)
    routes.ts               "/" | "/feature/<id>"; viewport ?lon=&lat=&z=                            (tested)
    main.tsx, App.tsx
    map/PlanetaryMap.tsx    MapCanvas + style + click → selection
    search/index.ts         load the ancestrie artifact, query it                                    (tested with a fixture artifact)
    search/SearchBox.tsx
    panels/FeaturePanel.tsx, panels/Attribution.tsx
    styles/app.css
  test/
    unit/{body,bodies,routes,search}.test.ts
    fixtures/moon-search.ancestrie   built by the astrogeology fixture test's builder over five names
    browser/planetary.spec.ts

packages/cartographer/lib/base/composition.ts     baseLayers, hillshadeSource, sprite become inputs (Earth defaults)
packages/cartographer/lib/planetary/{index,style,layers,sources}.ts
packages/cartographer/package.json                 exports "./planetary"
```

---

### Task 1: The composer takes its Earth assumptions as inputs

**Files:**

- Modify: `packages/cartographer/lib/base/composition.ts`
- Test: `packages/cartographer/test/unit/composition.test.ts` (create if absent; `ls packages/cartographer/test/unit`)

**Interfaces:**

- Produces: `StyleSpecificationComposition` gains `baseLayers?: LayerSpecification[]` (default `BaseLayers`), `hillshadeSource?: SourceSpecification | null` (default `createTerrainDEMSource()`; `null` adds none), `sprite?: string | null` (default the Protomaps v4 sprite; `null` omits the key), `glyphs?: string` (default the Protomaps font host). Existing callers pass none and get today's style byte for byte.

- [ ] **Step 1: The test first**

```ts
import { StyleSpecificationComposer } from "@mailwoman/cartographer/base"
import { expect, test } from "vitest"

test("a composition with no overrides is today's Earth style: base layers, the terrarium hillshade source, the sprite", () => {
	const style = new StyleSpecificationComposer({ sources: {} }).toJSON()

	expect(style.sprite).toMatch(/protomaps\/sprites\/v4\/light$/u)
	expect(Object.keys(style.sources)).toContain("hillshade")
	expect(style.layers.length).toBeGreaterThan(5)
})

test("a composition can bring its own base layers, no hillshade source and no sprite", () => {
	const style = new StyleSpecificationComposer({
		sources: { moon: { type: "vector", url: "https://tiles.mailwoman.ai/moon.json" } },
		baseLayers: [{ id: "space", type: "background", paint: { "background-color": "#000" } }],
		hillshadeSource: null,
		sprite: null,
	}).toJSON()

	expect(style.layers.map((layer) => layer.id)).toEqual(["space"])
	expect(Object.keys(style.sources)).toEqual(["moon"])
	expect("sprite" in style).toBe(false)
	expect(style.glyphs).toMatch(/protomaps\/fonts/u)
})
```

Run `yarn vitest --run --config vitest.fast.config.ts packages/cartographer/test/unit/composition.test.ts`; expected: the second test fails (the options are unknown and the Earth layers come back).

- [ ] **Step 2: The change**

In `composition.ts`, extend the interface and the constructor:

```ts
export interface StyleSpecificationComposition {
	sources: Record<string, SourceSpecification>
	layers?: LayerSpecificationListInput[]
	light?: Partial<LightSpecification>
	sky?: Partial<SkySpecification>
	terrain?: Partial<TerrainSpecification>
	/**
	 * The layer list every `layers` entry inserts into. Earth's basemap layers by default; a body with no roads,
	 * water or buildings brings its own.
	 */
	baseLayers?: LayerSpecification[]
	/**
	 * The `hillshade` source. Earth's terrarium DEM by default; `null` adds no such source.
	 */
	hillshadeSource?: SourceSpecification | null
	/**
	 * The sprite URL. Earth's Protomaps v4 sprite by default; `null` omits the key, for a style with no icons.
	 */
	sprite?: string | null
	glyphs?: string
}
```

The constructor stores `spec.baseLayers ?? BaseLayers` into the list, adds `[HillshadeTileSetID]: hillshadeSource` only when the resolved value is not `null`, and `toJSON` spreads `sprite` only when not `null` and uses `this.glyphs`. Keep the two URL constants as named module-level defaults (`PROTOMAPS_GLYPHS_URL`, `PROTOMAPS_SPRITE_URL`) so the comment above them stays the one place they are explained.

- [ ] **Step 3: Run, then the cartographer and docs consumers**

```bash
yarn vitest --run --config vitest.fast.config.ts packages/cartographer
yarn compile
cd docs && yarn typecheck && cd -
git add packages/cartographer
git commit -m "feat(cartographer): the style composer takes base layers, the hillshade source and the sprite as inputs, Earth by default"
```

---

### Task 2: `createPlanetaryStyle`

**Files:**

- Create: `packages/cartographer/lib/planetary/index.ts`, `sources.ts`, `layers.ts`, `style.ts`
- Modify: `packages/cartographer/package.json` (`exports["./planetary"]`), `packages/cartographer/lib/index.ts` if it re-exports subpaths (it does not need to)
- Test: `packages/cartographer/test/unit/planetary.test.ts`

**Interfaces:**

- Produces: `PlanetaryBodyID` re-used from `@mailwoman/spatial`; `PlanetaryStyleOptions { body: "moon" | "mars"; nomenclatureTileJSONURL: string; hillshadeTileJSONURL?: string }`; `createPlanetaryStyle(options): StyleSpecification`; the layer ids `planetary/space`, `planetary/hillshade`, `planetary/nomenclature-labels`, `planetary/selection`; the source ids `PlanetaryNomenclatureSourceID` (`"nomenclature"`) and `PlanetaryHillshadeSourceID` (`"hillshade"`).

- [ ] **Step 1: Test**

```ts
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec"
import { createPlanetaryStyle } from "@mailwoman/cartographer/planetary"
import { expect, test } from "vitest"

test.each(["moon", "mars"] as const)(
	"%s: a valid style with no Earth layer, no sprite, labels decluttered by diameter",
	(body) => {
		const style = createPlanetaryStyle({
			body,
			nomenclatureTileJSONURL: `https://tiles.mailwoman.ai/${body}.json`,
			hillshadeTileJSONURL: `https://tiles.mailwoman.ai/${body}-hillshade.json`,
		})

		expect(validateStyleMin(style)).toEqual([])
		expect(style.layers.map((layer) => layer.id)).toEqual([
			"planetary/space",
			"planetary/hillshade",
			"planetary/nomenclature-labels",
			"planetary/selection",
		])
		expect("sprite" in style).toBe(false)
		const labels = style.layers.find((layer) => layer.id === "planetary/nomenclature-labels")
		expect(labels?.type).toBe("symbol")
	}
)
```

`validateStyleMin` is the style-spec package's validator; the package is already a dependency of cartographer (`grep -n maplibre-gl-style-spec packages/cartographer/package.json`).

- [ ] **Step 2: Sources, layers, style**

`sources.ts`:

```ts
import { TileSetSourceID } from "#styles/sources"

export const PlanetaryNomenclatureSourceID = TileSetSourceID("nomenclature")
export const PlanetaryHillshadeSourceID = TileSetSourceID("hillshade")

/**
 * MapLibre resolves a TileJSON `url` itself: tiles, bounds, zoom range and attribution all come from the tile
 * worker's document, so nothing here restates them.
 */
export const nomenclatureSource = (tileJSONURL: string): VectorSourceSpecification => ({
	type: "vector",
	url: tileJSONURL,
})
export const hillshadeSource = (tileJSONURL: string): RasterSourceSpecification => ({
	type: "raster",
	url: tileJSONURL,
	tileSize: 256,
})
```

`layers.ts`, one function per layer, the palette per body:

```ts
export interface PlanetaryPalette {
	space: string
	labelColor: string
	labelHalo: string
	selection: string
}

export const PALETTES: Record<"moon" | "mars", PlanetaryPalette> = {
	moon: { space: "#05070d", labelColor: "#e8eef7", labelHalo: "#05070d", selection: "#7fd1ff" },
	mars: { space: "#0a0604", labelColor: "#f6e3d1", labelHalo: "#1a0c06", selection: "#ffb37f" },
}

export const spaceLayer = (palette: PlanetaryPalette): BackgroundLayerSpecification => ({
	id: "planetary/space",
	type: "background",
	paint: { "background-color": palette.space },
})

export const hillshadeLayer = (): RasterLayerSpecification => ({
	id: "planetary/hillshade",
	type: "raster",
	source: PlanetaryHillshadeSourceID,
	paint: { "raster-opacity": 0.9, "raster-resampling": "linear" },
})

/**
 * Labels by feature scale: the tile's per-feature `minzoom` already hides a small crater at a low zoom, so the
 * symbol layer only sizes and prioritizes. `code` is the IAU feature-type code carried in the tile properties
 * (AA crater, MO mons, VA vallis, ME mare, PL planitia, SF satellite feature).
 */
export const labelLayer = (palette: PlanetaryPalette): SymbolLayerSpecification => ({
	id: "planetary/nomenclature-labels",
	type: "symbol",
	source: PlanetaryNomenclatureSourceID,
	"source-layer": "nomenclature",
	layout: {
		"text-field": ["get", "name"],
		"text-font": ["Fira Sans Regular"],
		"text-size": ["interpolate", ["linear"], ["coalesce", ["get", "diameterKm"], 0], 0, 11, 100, 14, 1000, 18],
		"text-transform": ["match", ["get", "featureTypeCode"], ["ME", "PL", "OC", "TA"], "uppercase", "none"],
		"text-letter-spacing": ["match", ["get", "featureTypeCode"], ["ME", "PL", "OC", "TA"], 0.15, 0.02],
		"symbol-sort-key": ["-", 0, ["coalesce", ["get", "diameterKm"], 0]],
		"text-allow-overlap": false,
	},
	paint: { "text-color": palette.labelColor, "text-halo-color": palette.labelHalo, "text-halo-width": 1.2 },
})

export const selectionLayer = (palette: PlanetaryPalette): CircleLayerSpecification => ({
	id: "planetary/selection",
	type: "circle",
	source: PlanetaryNomenclatureSourceID,
	"source-layer": "nomenclature",
	filter: ["==", ["get", "id"], ""],
	paint: {
		"circle-radius": 14,
		"circle-color": "transparent",
		"circle-stroke-color": palette.selection,
		"circle-stroke-width": 2,
	},
})
```

`"Fira Sans Regular"` is a stack the Earth theme already loads from the same glyph host; check `grep -rho '"text-font": \[[^]]*\]' packages/cartographer/lib | sort -u` and use one of those stacks. `style.ts`:

```ts
export function createPlanetaryStyle(options: PlanetaryStyleOptions): StyleSpecification {
	const palette = PALETTES[options.body]
	const sources: Record<string, SourceSpecification> = {
		[PlanetaryNomenclatureSourceID]: nomenclatureSource(options.nomenclatureTileJSONURL),
	}
	if (options.hillshadeTileJSONURL) sources[PlanetaryHillshadeSourceID] = hillshadeSource(options.hillshadeTileJSONURL)

	const baseLayers = [
		spaceLayer(palette),
		...(options.hillshadeTileJSONURL ? [hillshadeLayer()] : []),
		labelLayer(palette),
		selectionLayer(palette),
	]

	return new StyleSpecificationComposer({
		sources,
		baseLayers,
		hillshadeSource: null,
		sprite: null,
		sky: { "sky-color": palette.space, "horizon-color": palette.space },
	}).toJSON()
}
```

The test's expected layer list assumes a hillshade URL; adjust the test to pass one, as written.

- [ ] **Step 3: Run, commit**

```bash
yarn vitest --run --config vitest.fast.config.ts packages/cartographer
yarn compile && yarn mwops health manifest-targets && yarn mwops health bundle-graph
git add packages/cartographer
git commit -m "feat(cartographer): createPlanetaryStyle — space, hillshade, labels by feature scale, selection, no Earth layer"
```

Add `browserRow("@mailwoman/cartographer/planetary")` to `bundle-graph.ts` in the same commit.

---

### Task 3: The workspace, the body, and the routes — test-first

**Files:**

- Create: `packages/planetary/package.json`, `tsconfig.json`, `tsconfig.test.json`, `lib/env.ts`, `lib/body.ts`, `lib/bodies/{index,moon,mars}.ts`, `lib/routes.ts`
- Test: `test/unit/body.test.ts`, `test/unit/bodies.test.ts`, `test/unit/routes.test.ts`
- Modify: the four registers (as in the Earth shell plan, Task 2 Step 3, with the values above)

**Interfaces:**

- Produces: `PlanetaryMapConfig { body: "moon" | "mars"; title: string; hostname: string; initialView: { longitude, latitude, zoom }; tiles: { nomenclature: string; hillshade: string }; artifacts: { version: string; searchIndexURL: string; manifestURL: string }; identity: PWAIdentity }`; `BODY_CONFIGS`; `currentBody(): "moon" | "mars"` (from `__PLANETARY_BODY__`); `assertHostMatchesBody(hostname, body)`; `routeForPath(pathname): { kind: "map" } | { kind: "feature"; id: string } | null`; `viewportFromSearch(search): { lon, lat, z } | null`.

- [ ] **Step 1: Tests**

`test/unit/body.test.ts`:

```ts
import { assertHostMatchesBody } from "@mailwoman/planetary/body"
import { expect, test } from "vitest"

test.each([
	["moon.mailwoman.ai", "moon"],
	["mars.mailwoman.ai", "mars"],
	["localhost", "moon"],
	["localhost", "mars"],
	["moon.mailwoman.ai.preview.example", "moon"],
] as const)("%s serves a %s build", (hostname, body) => {
	expect(() => assertHostMatchesBody(hostname, body)).not.toThrow()
})

test("a production host serving the other body's build fails, naming both", () => {
	expect(() => assertHostMatchesBody("mars.mailwoman.ai", "moon")).toThrow(/mars\.mailwoman\.ai.*moon/u)
})
```

`test/unit/routes.test.ts` covers `/` → map, `/feature/11150` → feature `11150`, `/feature/` → null, `/nowhere` → null, and `viewportFromSearch("?lon=-11.2&lat=-43.3&z=5")` → the three numbers, with a malformed value → null. `test/unit/bodies.test.ts` asserts both configs name their own hostname, that `tiles.nomenclature` ends in `/${body}.json`, and that `identity.origin` is `https://${hostname}/`.

- [ ] **Step 2: The modules**

`lib/env.ts`:

```ts
import { $public as corePublic, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

export const PublicPlanetaryEnvSchema = z.object({
	PLANETARY_BODY: z.enum(["moon", "mars"]).meta({
		title: "Planetary body",
		description:
			"Which body this build of the planetary app is for. Read once, at build; the client is compiled for it.",
	}),
})

export const $public = liveEnv(PublicPlanetaryEnvSchema, corePublic)
```

`lib/body.ts`:

```ts
declare const __PLANETARY_BODY__: "moon" | "mars"

export function currentBody(): "moon" | "mars" {
	return __PLANETARY_BODY__
}

const PRODUCTION_HOSTS: Record<"moon" | "mars", string> = { moon: "moon.mailwoman.ai", mars: "mars.mailwoman.ai" }

/**
 * A production host must serve its own body's build. Any other host (a preview, localhost) serves either, so the
 * check only fires when the hostname is one of the two production names.
 */
export function assertHostMatchesBody(hostname: string, body: "moon" | "mars"): void {
	const expected = Object.entries(PRODUCTION_HOSTS).find(([, host]) => host === hostname)?.[0]

	if (expected && expected !== body) {
		throw new Error(`${hostname} serves the ${expected} app, but this build is for ${body}`)
	}
}
```

`lib/bodies/moon.ts` (mars alike, with Tharsis as the initial view: longitude −110, latitude 10, zoom 2):

```ts
export const MOON: PlanetaryMapConfig = {
	body: "moon",
	title: "Mailwoman Moon",
	hostname: "moon.mailwoman.ai",
	initialView: { longitude: 0, latitude: 0, zoom: 1.5 },
	tiles: {
		nomenclature: "https://tiles.mailwoman.ai/moon.json",
		hillshade: "https://tiles.mailwoman.ai/moon-hillshade.json",
	},
	artifacts: {
		version: "<the version the astrogeology publish wrote>",
		searchIndexURL: "https://public.mailwoman.ai/planetary/moon/<version>/search.ancestrie",
		manifestURL: "https://public.mailwoman.ai/planetary/moon/<version>/manifest.json",
	},
	identity: { origin: "https://moon.mailwoman.ai/", name: "Mailwoman Moon", shortName: "Moon", themeColor: "#05070d" },
}
```

The `<version>` is the pipeline's build version string from its manifest (`astrogeology publish` prints it and the two URLs); it is a pin the same way Earth's resource versions are, and it changes by a commit here when the pipeline republishes. `lib/routes.ts` follows the Earth shell's `routes.ts` with the `/feature/<id>` pattern `^/feature/([0-9]+)$`.

- [ ] **Step 3: The manifest and Vite config**

`package.json` as the Earth shell's with `@mailwoman/planetary`, port 7790/7791, dependencies `@mailwoman/ancestrie`, `@mailwoman/cartographer`, `@mailwoman/core`, `@mailwoman/react`, `@mailwoman/site-kit`, `@mailwoman/spatial`, `maplibre-gl`, `react`, `react-dom`, `react-map-gl`, `workbox-precaching`, `zod`, and exports for `./body`, `./bodies`, `./routes`, `./search`. `vite.config.ts`:

```ts
import { buildInfoPlugin } from "@mailwoman/site-kit/vite/build-info"
import { installablePWA } from "@mailwoman/site-kit/vite/pwa"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

import { BODY_CONFIGS } from "./lib/bodies/index.ts"
import { $public } from "./lib/env.ts"

const body = $public.PLANETARY_BODY
const config = BODY_CONFIGS[body]

export default defineConfig({
	define: { __PLANETARY_BODY__: JSON.stringify(body) },
	publicDir: `public/icons/${body}`,
	plugins: [react(), VitePWA(installablePWA(config.identity)), buildInfoPlugin({ app: `mailwoman-${body}` })],
	build: { outDir: "dist", sourcemap: true },
	server: { port: 7791, strictPort: true },
})
```

`publicDir` selects the body's icon set; each `public/icons/<body>/` holds the three icons rendered from that body's SVG the way the Earth shell's are. The Vite config runs under Node, where `$public` reads the process environment; a missing `PLANETARY_BODY` fails the build with the schema's message, which is what "refuses an unknown value" means.

- [ ] **Step 4: Run, register, commit**

```bash
yarn install
yarn compile
yarn vitest --run --config vitest.fast.config.ts packages/planetary/test/unit
PLANETARY_BODY=moon yarn workspace @mailwoman/planetary build && cat packages/planetary/dist/build.json
PLANETARY_BODY=mars yarn workspace @mailwoman/planetary build && node -e "console.log(require('./packages/planetary/dist/manifest.webmanifest').id)"
git add package.json yarn.lock tsconfig.json packages/planetary packages/release-kit dependency-cruiser.config.cjs
git commit -m "feat(planetary): the workspace, the build-time body, routes, and the two body configs"
```

Expected: `build.json` says `mailwoman-moon`; the Mars manifest id is `https://mars.mailwoman.ai/`.

---

### Task 4: The map, selection, and the feature panel

**Files:**

- Create: `lib/App.tsx`, `lib/main.tsx`, `lib/map/PlanetaryMap.tsx`, `lib/panels/FeaturePanel.tsx`, `lib/styles/app.css`, `index.html`, `wrangler.toml`

**Interfaces:**

- Consumes: `MapCanvas` (or `DemoMap`) from `@mailwoman/react/map` with `mapStyle`, `initialViewState`, `projection: "globe"`, `mapRef`, `mapProps` (react-map-gl's `interactiveLayerIds`, `onClick`); `createPlanetaryStyle`; `currentBody`, `BODY_CONFIGS`, `routeForPath`, `viewportFromSearch`.
- Produces: a `SelectedFeature { id, name, featureType, featureTypeCode?, diameterKm?, centerLon, centerLat, origin?, approvalStatus?, approvalDate? }` state; `history.pushState` to `/feature/<id>` on select; the selection layer's filter set to the id.

- [ ] **Step 1: The map component**

```tsx
export function PlanetaryMap({ config, selected, onSelect }: PlanetaryMapProps) {
	const mapRef = useRef<MapRef>(null)
	const style = useMemo(
		() =>
			createPlanetaryStyle({
				body: config.body,
				nomenclatureTileJSONURL: config.tiles.nomenclature,
				hillshadeTileJSONURL: config.tiles.hillshade,
			}),
		[config]
	)
	const initial = viewportFromSearch(location.search) ?? config.initialView

	useEffect(() => {
		const map = mapRef.current?.getMap()
		if (!map?.isStyleLoaded()) return
		map.setFilter("planetary/selection", ["==", ["get", "id"], selected?.id ?? ""])
	}, [selected])

	const onClick = useCallback(
		(event: MapLayerMouseEvent) => {
			const feature = event.features?.[0]
			if (!feature) return
			onSelect(featureFromTileProperties(feature.properties))
		},
		[onSelect]
	)

	return (
		<MapCanvas
			mapStyle={style}
			initialViewState={{ longitude: initial.longitude, latitude: initial.latitude, zoom: initial.zoom }}
			projection="globe"
			mapRef={mapRef}
			mapProps={{ interactiveLayerIds: ["planetary/nomenclature-labels"], onClick, attributionControl: false }}
		>
			{selected ? (
				<ResultCamera
					target={{
						kind: "point",
						lngLat: [selected.centerLon, selected.centerLat],
						zoom: zoomForDiameter(selected.diameterKm),
					}}
					animate={!prefersReducedMotion()}
				/>
			) : null}
		</MapCanvas>
	)
}
```

Read `MapCameraTarget` in `packages/react/lib/map/place-render.ts` for the exact target shape before writing the `ResultCamera` line; `zoomForDiameter` is the inverse of the pipeline's declutter rule (≥300 km → 3, ≥100 → 5, ≥30 → 7, else 9). `prefersReducedMotion()` is `matchMedia("(prefers-reduced-motion: reduce)").matches`. `featureFromTileProperties` validates the tile's properties with the pipeline's `PlanetaryNomenclatureFeatureSchema.pick(...)` (import from `@mailwoman/astrogeology/schema/nomenclature`; a private sibling is importable by a private app).

- [ ] **Step 2: App, panel, HTML, wrangler**

`App.tsx` reads `currentBody()`, calls `assertHostMatchesBody(location.hostname, body)` (rendering an error page on throw), resolves the route, and composes `<SearchBox>`, `<PlanetaryMap>`, `<FeaturePanel>` and `<Attribution>`. A `/feature/<id>` route with no selection yet looks the id up in the search artifact (Task 5) to get its center and name, so the deep link restores the panel and camera without a tile query. `FeaturePanel` is semantic HTML: `<article aria-labelledby>` with a `<dl>` of name, type, coordinates (formatted to four decimals, east-positive, with the latitude type from the body), diameter, origin, approval status and date, and a "Source: USGS / IAU" line; a close button returns to `/` through `history.pushState`. `index.html`, `main.tsx`, `wrangler.toml` (`name = "mailwoman-planetary"` — the dashboard project name per body overrides it) follow the Earth shell's.

- [ ] **Step 3: Build both, look, commit**

```bash
PLANETARY_BODY=moon yarn workspace @mailwoman/planetary build && yarn workspace @mailwoman/planetary preview
```

Open `http://localhost:7790/`: a dark globe with lunar hillshade and labels; click Tycho; the panel shows 85.29 km and the URL becomes `/feature/<id>`. Then `PLANETARY_BODY=mars` and Olympus Mons. Commit:

```bash
git add packages/planetary
git commit -m "feat(planetary): the globe over the body's archives, click-to-select with a semantic feature panel, stable feature URLs"
```

---

### Task 5: Search over the pipeline's artifact

**Files:**

- Create: `lib/search/index.ts`, `lib/search/SearchBox.tsx`; `test/fixtures/moon-search.ancestrie`; `test/unit/search.test.ts`

**Interfaces:**

- Produces: `loadSearchIndex(url): Promise<PlanetarySearch>`; `PlanetarySearch.query(text, limit = 8): SearchHit[]` (`{ id, name, featureType, centerLon, centerLat }`); `PlanetarySearch.byID(id): SearchHit | null`.

- [ ] **Step 1: The fixture and test**

The fixture is built by the astrogeology package's `buildSearchIndex` over its five Moon fixture features; run that function once from a Node one-liner and commit the bytes (`ls -la` under 10 KB). `test/unit/search.test.ts`:

```ts
test("prefix search finds Tycho and ranks the larger feature first at a shared prefix", async () => {
	const search = await loadSearchIndex(fixtureURL)
	const hits = search.query("tyc")
	expect(hits[0]?.name).toBe("Tycho")
	expect(search.byID(hits[0]!.id)?.centerLat).toBeCloseTo(-43.2958, 3)
})

test("an alias resolves to its feature", async () => {
	const search = await loadSearchIndex(fixtureURL)
	expect(search.query("sea of tranq")[0]?.name).toBe("Mare Tranquillitatis")
})
```

Add Mare Tranquillitatis with its alias to the astrogeology Moon fixture if it is not among the five, so both packages' fixtures share it. `loadSearchIndex` fetches the bytes (in tests, `readLocalBuffer` through a `fetch` stub or a `file:` URL, whichever the reader's `from(Uint8Array)` makes simplest), builds `Ancestrie.from`, and `query` tokenizes with the reader's own tokenizer and calls `autocomplete(trie, tokens, { maxSuggestions: limit })`.

- [ ] **Step 2: The box**

`SearchBox` renders an `<input role="combobox">` with a listbox of hits, keyboard navigable (arrow keys, Enter, Escape), and calls `onSelect(hit)`; `@mailwoman/react/map`'s `PlaceAutocomplete` already renders a keyboard-navigable listbox over `Suggestion[]` (`suggestions`, `activeIndex`, `onPick`, `onHover`, `listboxID`, `optionID`), so the box composes it and maps `SearchHit` to `Suggestion { value: name, placetype: featureType }` rather than writing a second listbox.

- [ ] **Step 3: Run, commit**

```bash
yarn vitest --run --config vitest.fast.config.ts packages/planetary/test/unit
git add packages/planetary packages/astrogeology/test/fixtures
git commit -m "feat(planetary): search over the pipeline's ancestrie artifact, through the shared autocomplete listbox"
```

---

### Task 6: Attribution, the smoke, CI, README

**Files:**

- Create: `lib/panels/Attribution.tsx`, `test/browser/planetary.spec.ts`, `playwright.config.ts`, `README.md`
- Modify: `.github/workflows/test.yml` (the react leg gains two steps, one per body)

- [ ] **Step 1: Attribution from the manifest**

`Attribution` fetches `config.artifacts.manifestURL`, validates it with `PlanetaryBuildManifestSchema` from `@mailwoman/astrogeology/schema/manifest`, and renders one line per source (`USGS Astrogeology / IAU WGPSN — nomenclature, snapshot <date>`, `NASA LRO LOLA — terrain` or `NASA MGS MOLA — terrain`) plus `MapLibre`. Always visible, bottom-left, small.

- [ ] **Step 2: The smoke**

`playwright.config.ts`: `previewConfig({ port: 7790, remoteURLVariable: "MAILWOMAN_PLANETARY_URL" })`. The spec runs against whichever body the preview was built for and reads it from `/build.json`:

```ts
test("the globe loads for the built body, search finds a known feature, selection sets the URL and survives reload", async ({
	page,
	request,
}) => {
	const info = (await (await request.get("/build.json")).json()) as { app: string }
	const body = info.app.replace("mailwoman-", "") as "moon" | "mars"
	const known = body === "moon" ? { query: "tycho", name: "Tycho" } : { query: "olympus", name: "Olympus Mons" }

	await page.goto("/")
	await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible()
	await page.getByRole("combobox").fill(known.query)
	await page
		.getByRole("option", { name: new RegExp(known.name, "u") })
		.first()
		.click()
	await expect(page).toHaveURL(/\/feature\/\d+$/u)
	await expect(page.getByRole("article")).toContainText(known.name)

	await page.reload()
	await expect(page.getByRole("article")).toContainText(known.name)
})
```

The preview serves the real archives from `tiles.mailwoman.ai` and the search artifact from `public.mailwoman.ai`; this smoke needs the network, as the Earth production smoke does.

- [ ] **Step 3: CI and README**

In `.github/workflows/test.yml`, after the Earth smoke step:

```yaml
- name: Moon smoke
  run: yarn workspace @mailwoman/planetary test:browser
  env:
    PLANETARY_BODY: moon
- name: Mars smoke
  run: yarn workspace @mailwoman/planetary test:browser
  env:
    PLANETARY_BODY: mars
```

The README carries the Workers Builds table from the spec (two projects, `PLANETARY_BODY` as the build variable, custom domains), the commands, and the artifact-version pin and how `astrogeology publish` moves it.

- [ ] **Step 4: Preflight and PR**

```bash
yarn compile && yarn health > /tmp/health.log 2>&1; echo "EXIT=$?" >> /tmp/health.log; grep -n "✗\|error:\|EXIT=" /tmp/health.log | head
yarn typecheck:tests && yarn ci:test:fast
PLANETARY_BODY=moon yarn workspace @mailwoman/planetary test:browser
PLANETARY_BODY=mars yarn workspace @mailwoman/planetary test:browser
git push -u origin feat/planetary
gh pr create --title "Planetary: moon.mailwoman.ai and mars.mailwoman.ai from one app" --body-file - <<'EOF'
Implements docs/superpowers/specs/2026-09-06-planetary-app-design.md by docs/superpowers/plans/2026-09-07-planetary-app.md.

- @mailwoman/cartographer: the composer takes base layers, hillshade source and sprite as inputs (Earth by default); createPlanetaryStyle for the two bodies
- packages/planetary (private): one source, PLANETARY_BODY at build through the package's env, host-versus-body check at startup, the globe over the published archives, click-to-select with a semantic panel, /feature/<id> deep links, search over the pipeline's ancestrie artifact through the shared autocomplete listbox, attribution from the pipeline manifest
- site-kit's build plugin, PWA identity and Playwright config reused; nothing written twice

Two Workers Builds projects (root packages/planetary, build variable PLANETARY_BODY, custom domains) are dashboard steps for the operator; the README carries the table.

https://claude.ai/code/session_01ADYjzV88cHb94MRW4Dn1Aq
EOF
```
