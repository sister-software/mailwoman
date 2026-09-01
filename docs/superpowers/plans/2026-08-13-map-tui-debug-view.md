# `@mailwoman/map-tui` + `mw geocode --debug` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the frame-first `@mailwoman/map-tui` library workspace and the three-panel interactive/static `mw geocode --debug` view it powers.

**Architecture:** map-tui renders PMTiles vector tiles to a `MapFrame` cell-grid value (braille via `@sister.software/asciify` primitives) and never touches the terminal; the debug view is a pure Ink app consuming those frames — interactively on a TTY, as a one-shot captured frame when piped. The geocode CLI's dependency assembly is extracted into a reusable warm session so re-runs skip model load.

**Tech Stack:** TypeScript (erasable-syntax, direct-`node` type stripping), Ink 7 + Pastel, `@sister.software/asciify` 4.1 `./tui`, `pmtiles` 4.5, `@mapbox/vector-tile` 2 + `pbf` 4, vitest, tippecanoe (fixture generation only).

**Spec:** `docs/superpowers/specs/2026-08-13-debug-view-map-tui-design.md`

## Global Constraints

- Every source file starts with the house header: `@copyright Sister Software / @license AGPL-3.0 / @author Teffen Ellis, et al.`
- Relative imports use explicit `.ts` extensions; `rewriteRelativeImportExtensions: true`; `erasableSyntaxOnly: true` (no `enum`, no ctor param properties).
- Acronyms are whole camelCase components: `frameToANSILines`, `decodeMVT`, `placeID`, `RGBAGrid` — never `frameToAnsiLines`/`decodeMvt`.
- No raw `process.env` — env goes through `core/env/schema.ts` + `$public`. (`process.stdout.isTTY` is fine; the rule binds env/argv.)
- No `!== undefined` predicates — use presence/nullish checks (`x != null`, `typeof x === "number"`).
- The #1577 contract is inviolable: the non-debug geocode success path never renders through Ink; `geocode.test.ts` must pass **unmodified**.
- Databases/tiles are read-only artifacts; tiles are never shipped in any package.
- Run tests from the repo root: `yarn vitest run <path>`. Run `yarn compile` before exercising the compiled CLI (`node mailwoman/out/cli.js`).
- Engines: `node >= 24.18.0` (all workspaces). New workspace version matches siblings: `9.1.0`.
- Commit after every task; prefix `map-tui:` or `geocode:` matching repo style. Pre-commit hook is lint-only and staged-scoped.

---

## Part A — `@mailwoman/map-tui`

### Task 1: Bootstrap the workspace

**Files:**

- Create: `map-tui/package.json`, `map-tui/tsconfig.json`, `map-tui/index.ts`, `map-tui/README.md`
- Modify: root `package.json` (workspaces array), root `tsconfig.json` (references, if it carries one)

**Interfaces:**

- Produces: an installable `@mailwoman/map-tui` workspace whose root export resolves in vitest (the root vitest config auto-derives aliases from each workspace's `exports` map).

- [ ] **Step 1: Write the manifest.** Model on `spatial/package.json` (same `files` globs, `publishConfig.access: "public"`, `repository.directory: "map-tui"`, engines). Dependencies:

```json
{
	"name": "@mailwoman/map-tui",
	"version": "9.1.0",
	"description": "Terminal vector-tile map renderer — braille map frames for TUIs, from PMTiles.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"contributors": [{ "name": "Teffen Ellis", "email": "teffen@sister.software" }],
	"repository": {
		"type": "git",
		"url": "https://github.com/sister-software/mailwoman.git",
		"directory": "map-tui"
	},
	"files": ["out/", "*.ts", "**/*.ts", "!*.test.ts", "!**/*.test.ts", "!test/", "!scripts/", "!__snapshots__/"],
	"type": "module",
	"exports": {
		"./package.json": "./package.json",
		".": {
			"node": "./index.ts",
			"default": "./out/index.js",
			"types": "./out/index.d.ts"
		}
	},
	"publishConfig": { "access": "public" },
	"dependencies": {
		"@mapbox/vector-tile": "^2.0.3",
		"@sister.software/asciify": "^4.1.0",
		"pbf": "^4.0.1",
		"pmtiles": "^4.5.0"
	},
	"engines": { "node": ">=24.18.0" }
}
```

Note the `files` array excludes `test/` and `scripts/` — the fixture and its generator never publish.

- [ ] **Step 2: Write `map-tui/tsconfig.json`** — copy `spatial/tsconfig.json`, drop the decorator options (not needed here), empty `references` (no internal deps):

```json
{
	"extends": "@sister.software/tsconfig/node",
	"compilerOptions": {
		"allowSyntheticDefaultImports": true,
		"emitDeclarationOnly": false,
		"rewriteRelativeImportExtensions": true,
		"erasableSyntaxOnly": true
	},
	"exclude": ["./out/**/*", "./**/*.test.ts", "./test/**/*", "./scripts/**/*"],
	"references": []
}
```

- [ ] **Step 3: Register the workspace.** Add `"map-tui"` to the root `package.json` `workspaces` array (match the array's existing ordering convention — inspect it first; 54 entries become 55). Check whether the root `tsconfig.json` carries a `references` list of workspaces; if so, add `{ "path": "./map-tui" }` in matching order.

- [ ] **Step 4: Stub the entry.** `map-tui/index.ts` with the house header and an empty export list (`export {}` placeholder to be replaced by Task 8's re-exports).

- [ ] **Step 5: Install + verify.** Run `yarn install`, then `yarn lint`. Expected: install resolves the four new deps; lint passes.

- [ ] **Step 6: README.** Three short paragraphs: what the package is (frame-first terminal map renderer), the `MapFrame` contract (frames are values; consumers own presentation), where tiles come from (caller-supplied PMTiles path; never bundled).

- [ ] **Step 7: Commit.** `map-tui: bootstrap the workspace`

### Task 2: Web-mercator math (`mercator.ts`)

**Files:**

- Create: `map-tui/mercator.ts`, `map-tui/mercator.test.ts`

**Interfaces:**

- Produces (consumed by raster/renderer tasks):

```ts
export const TILE_SIZE = 256
export interface LonLat {
	lon: number
	lat: number
}
export interface WorldPx {
	x: number
	y: number
}
/** Lon/lat → absolute pixel position in the world plane at `zoom` (TILE_SIZE px per tile). */
export function lonLatToWorldPx(lon: number, lat: number, zoom: number): WorldPx
export function worldPxToLonLat(x: number, y: number, zoom: number): LonLat
/** Ground resolution at a latitude, meters per world pixel. */
export function metersPerPixel(lat: number, zoom: number): number
```

A file-top comment records the priced-and-declined dependency: `@mailwoman/cartographer/tiles/coords` has this math but drags `maplibre-gl` + `@mailwoman/tiger`; `@mailwoman/spatial` drags `@mailwoman/core`'s shipped data. map-tui stays dependency-lean for the standalone `npx` story (the `nuts-lookup` precedent).

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest"
import { lonLatToWorldPx, metersPerPixel, TILE_SIZE, worldPxToLonLat } from "./mercator.ts"

describe("lonLatToWorldPx", () => {
	it("maps the origin to the center of the world plane", () => {
		const { x, y } = lonLatToWorldPx(0, 0, 0)
		expect(x).toBeCloseTo(TILE_SIZE / 2, 6)
		expect(y).toBeCloseTo(TILE_SIZE / 2, 6)
	})

	it("round-trips Portland at z15", () => {
		const px = lonLatToWorldPx(-122.6023, 45.5034, 15)
		const back = worldPxToLonLat(px.x, px.y, 15)
		expect(back.lon).toBeCloseTo(-122.6023, 6)
		expect(back.lat).toBeCloseTo(45.5034, 6)
	})

	it("doubles pixel coordinates per zoom step", () => {
		const z3 = lonLatToWorldPx(-122.6, 45.5, 3)
		const z4 = lonLatToWorldPx(-122.6, 45.5, 4)
		expect(z4.x).toBeCloseTo(z3.x * 2, 6)
		expect(z4.y).toBeCloseTo(z3.y * 2, 6)
	})
})

describe("metersPerPixel", () => {
	it("matches the equatorial ground resolution at z0", () => {
		// 40,075,016.686 m circumference / 256 px
		expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03392, 2)
	})

	it("shrinks with cos(lat)", () => {
		expect(metersPerPixel(60, 10) / metersPerPixel(0, 10)).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 6)
	})
})
```

- [ ] **Step 2: Run to verify failure.** `yarn vitest run map-tui/mercator.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement.**

```ts
export const TILE_SIZE = 256

export interface LonLat {
	lon: number
	lat: number
}
export interface WorldPx {
	x: number
	y: number
}

export function lonLatToWorldPx(lon: number, lat: number, zoom: number): WorldPx {
	const scale = TILE_SIZE * 2 ** zoom
	const sin = Math.sin((lat * Math.PI) / 180)

	return {
		x: scale * (lon / 360 + 0.5),
		y: scale * (0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI),
	}
}

export function worldPxToLonLat(x: number, y: number, zoom: number): LonLat {
	const scale = TILE_SIZE * 2 ** zoom
	const n = Math.PI * (1 - (2 * y) / scale)

	return {
		lon: (x / scale - 0.5) * 360,
		lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
	}
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686

export function metersPerPixel(lat: number, zoom: number): number {
	return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom)
}
```

- [ ] **Step 4: Run to verify pass.** Same command — PASS.

- [ ] **Step 5: Commit.** `map-tui: web-mercator projection math`

### Task 3: Synthetic test fixture (`test/fixtures/portland.pmtiles`)

**Files:**

- Create: `map-tui/scripts/build-fixture.sh`, `map-tui/test/fixtures/src/*.geojson` (five files), committed `map-tui/test/fixtures/portland.pmtiles`

**Interfaces:**

- Produces: a committed PMTiles archive with protomaps-schema layer names (`earth`, `water`, `roads`, `boundaries`, `places`), extent ≈ Portland SE quadrant (lon −122.68..−122.55, lat 45.47..45.55), zooms 0–15. Synthetic hand-authored geometry — no OSM derivation, so no ODbL question enters the repo.

- [ ] **Step 1: Author the GeoJSON sources.** Five files under `test/fixtures/src/`. Keep coordinates inside the extent above. Required content (each a `FeatureCollection`):
  - `earth.geojson` — one polygon covering the whole extent.
  - `water.geojson` — one river-ish polygon along the western edge (lon < −122.66).
  - `roads.geojson` — a small grid: 4 north–south lines, 4 east–west lines; one east–west line at lat 45.5034 carries `{"name": "SE Clinton St", "kind": "minor_road"}`; give one line `{"kind": "major_road"}`.
  - `boundaries.geojson` — one diagonal LineString.
  - `places.geojson` — two points: `{"name": "Portland", "kind": "locality"}` at (−122.60, 45.52) and `{"name": "Clinton", "kind": "neighbourhood"}` at (−122.6023, 45.5034).

- [ ] **Step 2: Write the generator script.**

```bash
#!/usr/bin/env bash
# Regenerates portland.pmtiles from the hand-authored GeoJSON sources.
# Requires tippecanoe (https://github.com/felt/tippecanoe). The output is
# COMMITTED so tests and CI never need tippecanoe installed.
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures"

tippecanoe -o portland.pmtiles --force -Z0 -z15 \
	--no-tile-size-limit \
	-L earth:src/earth.geojson \
	-L water:src/water.geojson \
	-L roads:src/roads.geojson \
	-L boundaries:src/boundaries.geojson \
	-L places:src/places.geojson
```

- [ ] **Step 3: Generate + size-check.** Run the script; then `ls -la map-tui/test/fixtures/portland.pmtiles` and `pmtiles show map-tui/test/fixtures/portland.pmtiles`. Expected: file well under 1 MB (a handful of features; likely tens of KB) and the five layers listed. If over 1 MB, drop `-z15` to `-z14` and re-check.

- [ ] **Step 4: Commit** (fixture + sources + script). `map-tui: synthetic Portland fixture tiles`

### Task 4: PMTiles source + MVT decode (`tile-source.ts`, `mvt.ts`)

**Files:**

- Create: `map-tui/mvt.ts`, `map-tui/tile-source.ts`, `map-tui/tile-source.test.ts`

**Interfaces:**

- Produces:

```ts
// mvt.ts
export interface DecodedFeature {
	/** 1 = point, 2 = line, 3 = polygon (MVT geometry types). */
	type: 1 | 2 | 3
	/** Rings/lines/points in tile-local integer coords (0..extent). */
	geometry: Array<Array<{ x: number; y: number }>>
	properties: Record<string, unknown>
}
export interface DecodedLayer {
	name: string
	extent: number
	features: DecodedFeature[]
}
export function decodeMVT(data: Uint8Array): DecodedLayer[]

// tile-source.ts
export interface DecodedTile {
	layers: DecodedLayer[]
}
export class TileSource {
	static async open(path: string): Promise<TileSource>
	readonly minZoom: number
	readonly maxZoom: number
	/** Plain-text attribution from archive metadata (HTML tags stripped); empty string when absent. */
	readonly attribution: string
	/** Decoded tile, LRU-cached (64 entries). null = tile absent from the archive. */
	getTile(z: number, x: number, y: number): Promise<DecodedTile | null>
	close(): Promise<void>
}
```

- [ ] **Step 1: Write the failing tests.**

```ts
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { TileSource } from "./tile-source.ts"

const FIXTURE = fileURLToPath(new URL("./test/fixtures/portland.pmtiles", import.meta.url))

describe("TileSource", async () => {
	const source = await TileSource.open(FIXTURE)

	afterAll(() => source.close())

	it("reads header zoom bounds", () => {
		expect(source.minZoom).toBe(0)
		expect(source.maxZoom).toBeGreaterThanOrEqual(14)
	})

	it("decodes the z0 world tile with the fixture layers", async () => {
		const tile = await source.getTile(0, 0, 0)
		expect(tile).not.toBeNull()
		const names = tile!.layers.map((layer) => layer.name).sort()
		expect(names).toContain("earth")
		expect(names).toContain("roads")
	})

	it("finds SE Clinton St at high zoom", async () => {
		// z14 tile containing (-122.6023, 45.5034): x = floor(2**14 * (lon/360 + 0.5)) = 2612,
		// y = floor(lonLatToWorldPx(lon, lat, 14).y / 256) = 5861.
		const tile = await source.getTile(14, 2612, 5861)
		expect(tile).not.toBeNull()
		const roads = tile!.layers.find((layer) => layer.name === "roads")
		const named = roads!.features.map((f) => f.properties["name"]).filter(Boolean)
		expect(named).toContain("SE Clinton St")
	})

	it("returns null for a tile outside the archive", async () => {
		expect(await source.getTile(14, 0, 0)).toBeNull()
	})
})
```

Verify the z14 x/y literals with Task 2's own functions before trusting a failure: `floor(2**14 * ((-122.6023)/360 + 0.5))` = 2612 and `floor(lonLatToWorldPx(-122.6023, 45.5034, 14).y / 256)` = 5861.

- [ ] **Step 2: Run to verify failure.** `yarn vitest run map-tui/tile-source.test.ts` — FAIL.

- [ ] **Step 3: Implement `mvt.ts`.**

```ts
import { VectorTile } from "@mapbox/vector-tile"
import Pbf from "pbf"

export function decodeMVT(data: Uint8Array): DecodedLayer[] {
	const tile = new VectorTile(new Pbf(data))

	return Object.entries(tile.layers).map(([name, layer]) => {
		const features: DecodedFeature[] = []

		for (let index = 0; index < layer.length; index++) {
			const feature = layer.feature(index)

			features.push({
				type: feature.type as 1 | 2 | 3,
				geometry: feature.loadGeometry(),
				properties: feature.properties as Record<string, unknown>,
			})
		}

		return { name, extent: layer.extent, features }
	})
}
```

(Plus the two interface declarations from the Interfaces block.) If `@mapbox/vector-tile` v2's import shape differs (named vs default), follow its types — the test is the arbiter.

- [ ] **Step 4: Implement `tile-source.ts`.** A `FilePMTilesSource` implementing pmtiles' `Source` over `node:fs/promises` `FileHandle.read`, wrapped by `TileSource`:

```ts
import { open, type FileHandle } from "node:fs/promises"
import { PMTiles, type RangeResponse, type Source } from "pmtiles"
import { decodeMVT } from "./mvt.ts"

class FilePMTilesSource implements Source {
	constructor(
		private readonly path: string,
		private readonly handle: FileHandle
	) {}

	getKey(): string {
		return this.path
	}

	async getBytes(offset: number, length: number): Promise<RangeResponse> {
		const buffer = Buffer.alloc(length)
		const { bytesRead } = await this.handle.read(buffer, 0, length, offset)

		return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) }
	}
}

const TILE_CACHE_LIMIT = 64
```

`TileSource.open(path)`: open the handle, construct `new PMTiles(new FilePMTilesSource(...))`, await `getHeader()` (minZoom/maxZoom) and `getMetadata()` (attribution: read `attribution` if it's a string, strip tags with `.replace(/<[^>]+>/gu, "")`, trim). `getTile`: key `` `${z}/${x}/${y}` ``, consult the cache Map first (delete+set to refresh recency; evict the oldest key past `TILE_CACHE_LIMIT`); on miss call `getZxy(z, x, y)`; `undefined` → cache and return null; otherwise `decodeMVT(new Uint8Array(response.data))`. pmtiles decompresses tile data internally (native `DecompressionStream`); if the fixture test fails on gzip magic bytes, gunzip via `node:zlib` `gunzipSync` when `data[0] === 0x1f`. `close()`: close the handle.

- [ ] **Step 5: Run to verify pass.** — PASS.

- [ ] **Step 6: Commit.** `map-tui: PMTiles file source + MVT decode`

### Task 5: Style table (`style.ts`)

**Files:**

- Create: `map-tui/style.ts`, `map-tui/style.test.ts`

**Interfaces:**

- Produces:

```ts
export type RGB = readonly [red: number, green: number, blue: number]
export interface FillStyle {
	kind: "fill"
	color: RGB
	minZoom: number
}
export interface LineStyle {
	kind: "line"
	color: RGB
	minZoom: number
	width: (zoom: number) => number
}
export interface LabelStyle {
	kind: "label"
	color: RGB
	minZoom: number
	property: string
}
export type LayerStyle = FillStyle | LineStyle | LabelStyle
/** Styles applying to a protomaps-basemap layer at a zoom, draw-ordered (fills < lines < labels). Empty for unstyled/gated layers. */
export function stylesFor(layerName: string, zoom: number): LayerStyle[]
```

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest"
import { stylesFor } from "./style.ts"

describe("stylesFor", () => {
	it("fills water at every zoom", () => {
		const styles = stylesFor("water", 0)
		expect(styles).toHaveLength(1)
		expect(styles[0]!.kind).toBe("fill")
	})

	it("labels places", () => {
		const styles = stylesFor("places", 4)
		expect(styles.some((s) => s.kind === "label" && s.property === "name")).toBe(true)
	})

	it("gates buildings until high zoom", () => {
		expect(stylesFor("buildings", 10)).toHaveLength(0)
		expect(stylesFor("buildings", 14).length).toBeGreaterThan(0)
	})

	it("returns empty for unknown layers", () => {
		expect(stylesFor("nonexistent", 10)).toEqual([])
	})
})
```

- [ ] **Step 2: Run to verify failure.** — FAIL.

- [ ] **Step 3: Implement.** A single `const STYLE_TABLE: Record<string, LayerStyle[]>` covering the nine protomaps layers, `stylesFor` filtering by `zoom >= minZoom`. Dark-terminal palette — dim fills (dither renders fill luminance as stipple density: keep fills ≤ ~90 luminance so they read as texture), bright lines/labels:

```ts
const STYLE_TABLE: Record<string, LayerStyle[]> = {
	earth: [{ kind: "fill", color: [40, 44, 36], minZoom: 0 }],
	landcover: [{ kind: "fill", color: [36, 52, 32], minZoom: 4 }],
	landuse: [{ kind: "fill", color: [48, 48, 40], minZoom: 10 }],
	water: [{ kind: "fill", color: [24, 48, 90], minZoom: 0 }],
	buildings: [{ kind: "fill", color: [70, 66, 60], minZoom: 13 }],
	boundaries: [{ kind: "line", color: [140, 110, 160], minZoom: 0, width: () => 1 }],
	roads: [{ kind: "line", color: [170, 170, 150], minZoom: 6, width: (zoom) => (zoom >= 14 ? 2 : 1) }],
	places: [{ kind: "label", color: [235, 235, 220], minZoom: 2, property: "name" }],
	pois: [{ kind: "label", color: [180, 200, 160], minZoom: 14, property: "name" }],
}

export function stylesFor(layerName: string, zoom: number): LayerStyle[] {
	return (STYLE_TABLE[layerName] ?? []).filter((style) => zoom >= style.minZoom)
}
```

- [ ] **Step 4: Run to verify pass.** — PASS.

- [ ] **Step 5: Commit.** `map-tui: protomaps-basemap style table`

### Task 6: Pixel rasterizer (`raster.ts`)

**Files:**

- Create: `map-tui/raster.ts`, `map-tui/raster.test.ts`

**Interfaces:**

- Produces:

```ts
import type { RGB } from "./style.ts"
export class RGBAGrid {
	constructor(width: number, height: number)
	readonly width: number
	readonly height: number
	/** RGBA, row-major, width*height*4 bytes — the shape asciify's rasterize consumes. */
	readonly data: Uint8ClampedArray
	setPixel(x: number, y: number, color: RGB): void // out-of-bounds ignored (clipping)
}
export function drawPolyline(
	grid: RGBAGrid,
	points: ReadonlyArray<{ x: number; y: number }>,
	color: RGB,
	width: number
): void
export function fillPolygon(
	grid: RGBAGrid,
	rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
	color: RGB
): void
export function drawCircle(grid: RGBAGrid, centerX: number, centerY: number, radius: number, color: RGB): void
```

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest"
import { drawCircle, drawPolyline, fillPolygon, RGBAGrid } from "./raster.ts"

function litPixels(grid: RGBAGrid): Array<[number, number]> {
	const lit: Array<[number, number]> = []
	for (let y = 0; y < grid.height; y++) {
		for (let x = 0; x < grid.width; x++) {
			if (grid.data[(y * grid.width + x) * 4 + 3]! > 0) lit.push([x, y])
		}
	}
	return lit
}

describe("drawPolyline", () => {
	it("draws a contiguous diagonal", () => {
		const grid = new RGBAGrid(8, 8)
		drawPolyline(
			grid,
			[
				{ x: 0, y: 0 },
				{ x: 7, y: 7 },
			],
			[255, 255, 255],
			1
		)
		const lit = litPixels(grid)
		expect(lit).toHaveLength(8)
		expect(lit).toContainEqual([0, 0])
		expect(lit).toContainEqual([7, 7])
	})

	it("clips out-of-bounds segments instead of throwing", () => {
		const grid = new RGBAGrid(4, 4)
		drawPolyline(
			grid,
			[
				{ x: -10, y: 2 },
				{ x: 10, y: 2 },
			],
			[255, 0, 0],
			1
		)
		expect(litPixels(grid)).toHaveLength(4)
	})
})

describe("fillPolygon", () => {
	it("fills a rectangle interior", () => {
		const grid = new RGBAGrid(10, 10)
		fillPolygon(
			grid,
			[
				[
					{ x: 2, y: 2 },
					{ x: 7, y: 2 },
					{ x: 7, y: 7 },
					{ x: 2, y: 7 },
				],
			],
			[0, 0, 255]
		)
		const lit = litPixels(grid)
		expect(lit).toContainEqual([4, 4])
		expect(lit).not.toContainEqual([0, 0])
		expect(lit).not.toContainEqual([9, 9])
	})

	it("respects holes (even-odd rule)", () => {
		const grid = new RGBAGrid(12, 12)
		fillPolygon(
			grid,
			[
				[
					{ x: 1, y: 1 },
					{ x: 10, y: 1 },
					{ x: 10, y: 10 },
					{ x: 1, y: 10 },
				],
				[
					{ x: 4, y: 4 },
					{ x: 7, y: 4 },
					{ x: 7, y: 7 },
					{ x: 4, y: 7 },
				],
			],
			[0, 255, 0]
		)
		const lit = litPixels(grid)
		expect(lit).toContainEqual([2, 2])
		expect(lit).not.toContainEqual([5, 5])
	})
})

describe("drawCircle", () => {
	it("draws a ring, not a disc", () => {
		const grid = new RGBAGrid(16, 16)
		drawCircle(grid, 8, 8, 5, [255, 255, 0])
		const lit = litPixels(grid)
		expect(lit.length).toBeGreaterThan(8)
		expect(lit).not.toContainEqual([8, 8])
	})
})
```

- [ ] **Step 2: Run to verify failure.** — FAIL.

- [ ] **Step 3: Implement.** `RGBAGrid.setPixel` writes RGB + alpha 255 with bounds check. `drawPolyline`: per-segment integer Bresenham; `width > 1` stamps a `width`-sized square at each step. `fillPolygon`: classic even-odd scanline — for each row y, collect x-intersections of every ring edge crossing y+0.5, sort, fill alternate pairs. `drawCircle`: midpoint circle algorithm (8-way symmetry), ring only. All coordinates floored on entry; everything clips through `setPixel`.

- [ ] **Step 4: Run to verify pass.** — PASS.

- [ ] **Step 5: Commit.** `map-tui: RGBA pixel rasterizer (lines, fills, rings)`

### Task 7: Frame value + braille conversion (`frame.ts`)

**Files:**

- Create: `map-tui/frame.ts`, `map-tui/frame.test.ts`

**Interfaces:**

- Produces:

```ts
export interface MapFrame {
	columns: number
	rows: number
	/** Codepoint per cell, row-major (braille U+2800.. or overlay text). */
	chars: Uint32Array
	/** 0xRRGGBB per cell; 0 = inkless. */
	colors: Uint32Array
	attribution: string
}
/** Converts a 2×4-subpixel RGBA grid into braille cells. Grid must be columns*2 × rows*4. */
export function rasterizeToFrame(grid: RGBAGrid, columns: number, rows: number, attribution: string): MapFrame
/** One SGR-styled string per row. `color: false` strips styling (NO_COLOR consumers). */
export function frameToANSILines(frame: MapFrame, options?: { color?: boolean }): string[]
/** Writes text into cells (clipped); occupied is the label-collision bitmap, updated in place. */
export function overlayText(
	frame: MapFrame,
	column: number,
	row: number,
	text: string,
	color: number,
	occupied?: Uint8Array
): boolean
```

`rasterizeToFrame` subclasses asciify's `AsciifyTerminal` with a no-op sink to reach the protected braille conversion — the protected members (`_computeBrailleCells`, `_cellChars`, `_cellColors`) are accessible from a subclass, so asciify's dither/luminance logic is reused rather than re-implemented:

```ts
import { AsciifyTerminal } from "@sister.software/asciify/tui"

class FrameRasterizer extends AsciifyTerminal {
	constructor(columns: number, rows: number) {
		super({ write: () => true, columns, rows }, { mode: "braille", colorDepth: "truecolor", synchronizedOutput: false })
		this.setSize(columns, rows)
	}

	toCells(buffer: Uint8ClampedArray): { chars: Uint32Array; colors: Uint32Array } {
		this._computeBrailleCells(buffer, false)

		return { chars: this._cellChars.slice(), colors: this._cellColors.slice() }
	}
}
```

If `TerminalLike` requires more members than `write`/`columns`/`rows`, satisfy its type minimally — the sink is never flushed to.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from "vitest"
import { frameToANSILines, overlayText, rasterizeToFrame } from "./frame.ts"
import { RGBAGrid } from "./raster.ts"

const BRAILLE_FULL = 0x28ff // all 8 dots

describe("rasterizeToFrame", () => {
	it("turns a fully lit grid into full braille cells", () => {
		const grid = new RGBAGrid(4, 8) // 2 columns × 2 rows of cells
		for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) grid.setPixel(x, y, [255, 255, 255])
		const frame = rasterizeToFrame(grid, 2, 2, "test")
		expect(Array.from(frame.chars)).toEqual([BRAILLE_FULL, BRAILLE_FULL, BRAILLE_FULL, BRAILLE_FULL])
	})

	it("leaves a dark grid blank", () => {
		const frame = rasterizeToFrame(new RGBAGrid(4, 8), 2, 2, "")
		expect(frame.chars[0]).toBe(0x2800)
		expect(frame.colors[0]).toBe(0)
	})
})

describe("frameToANSILines", () => {
	it("emits one line per row and resets styling", () => {
		const grid = new RGBAGrid(4, 8)
		grid.setPixel(0, 0, [255, 0, 0])
		const frame = rasterizeToFrame(grid, 2, 2, "")
		const lines = frameToANSILines(frame)
		expect(lines).toHaveLength(2)
		expect(lines[0]).toContain("[38;2;")
		expect(lines[0]!.endsWith("[0m")).toBe(true)
	})

	it("strips styling when color is off", () => {
		const grid = new RGBAGrid(4, 8)
		grid.setPixel(0, 0, [255, 0, 0])
		const frame = rasterizeToFrame(grid, 2, 2, "")
		expect(frameToANSILines(frame, { color: false })[0]).not.toContain("[")
	})
})

describe("overlayText", () => {
	it("writes text cells and reports collision through the bitmap", () => {
		const frame = rasterizeToFrame(new RGBAGrid(20, 4), 10, 1, "")
		const occupied = new Uint8Array(10)
		expect(overlayText(frame, 1, 0, "Portland", 0xffffff, occupied)).toBe(true)
		expect(String.fromCodePoint(frame.chars[1]!)).toBe("P")
		expect(overlayText(frame, 3, 0, "X", 0xffffff, occupied)).toBe(false)
	})
})
```

- [ ] **Step 2: Run to verify failure.** — FAIL.

- [ ] **Step 3: Implement.** `rasterizeToFrame` constructs a `FrameRasterizer` per call (cheap: two typed arrays), asserts `grid.width === columns * 2 && grid.height === rows * 4` (throw on mismatch — a sizing bug, not a clip). `frameToANSILines`: per row, walk cells; when `color` differs from the running color and the cell is inked, emit `[38;2;R;G;Bm`; append `String.fromCodePoint(char)` (0 → space); terminate each styled line with `[0m`. `overlayText`: bounds-clip; when `occupied` given, first check every target cell (+1 cell padding left/right) is free, return false on any hit, else write chars + colors and mark occupied.

- [ ] **Step 4: Run to verify pass.** — PASS.

- [ ] **Step 5: Commit.** `map-tui: MapFrame value + braille conversion via asciify`

### Task 8: The renderer (`renderer.ts`) + package exports

**Files:**

- Create: `map-tui/renderer.ts`, `map-tui/renderer.test.ts`
- Modify: `map-tui/index.ts` (real re-exports)

**Interfaces:**

- Consumes: everything above.
- Produces (the package's public surface):

```ts
export interface Viewport {
	centerLon: number
	centerLat: number
	zoom: number
	columns: number
	rows: number
}
export interface MarkerSpec {
	lon: number
	lat: number
	char?: string
	color?: RGB
} // default "●", [255, 80, 80]
export interface RingSpec {
	lon: number
	lat: number
	radiusMeters: number
}
export class MapRenderer {
	constructor(source: TileSource)
	renderFrame(viewport: Viewport, overlays?: { markers?: MarkerSpec[]; ring?: RingSpec }): Promise<MapFrame>
}
```

`index.ts` re-exports: `mercator.ts`, `mvt.ts`, `tile-source.ts`, `style.ts`, `raster.ts`, `frame.ts`, `renderer.ts`.

- [ ] **Step 1: Write the failing golden-frame tests.**

```ts
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { frameToANSILines } from "./frame.ts"
import { MapRenderer } from "./renderer.ts"
import { TileSource } from "./tile-source.ts"

const FIXTURE = fileURLToPath(new URL("./test/fixtures/portland.pmtiles", import.meta.url))

function plainText(frame: import("./frame.ts").MapFrame): string {
	return frameToANSILines(frame, { color: false }).join("\n")
}

describe("MapRenderer", async () => {
	const source = await TileSource.open(FIXTURE)
	const renderer = new MapRenderer(source)

	afterAll(() => source.close())

	it("renders the Clinton St viewport at z14 (golden frame)", async () => {
		const frame = await renderer.renderFrame({
			centerLon: -122.6023,
			centerLat: 45.5034,
			zoom: 14,
			columns: 60,
			rows: 24,
		})
		expect(plainText(frame)).toMatchSnapshot()
	})

	it("renders the zoomed-out extent at z11 (golden frame)", async () => {
		const frame = await renderer.renderFrame({ centerLon: -122.61, centerLat: 45.51, zoom: 11, columns: 60, rows: 24 })
		expect(plainText(frame)).toMatchSnapshot()
	})

	it("stamps a marker cell over the map", async () => {
		const frame = await renderer.renderFrame(
			{ centerLon: -122.6023, centerLat: 45.5034, zoom: 14, columns: 21, rows: 11 },
			{ markers: [{ lon: -122.6023, lat: 45.5034 }] }
		)
		// Center cell of an odd-sized viewport is the marker anchor.
		expect(String.fromCodePoint(frame.chars[5 * 21 + 10]!)).toBe("●")
	})

	it("carries the archive attribution", async () => {
		const frame = await renderer.renderFrame({ centerLon: -122.61, centerLat: 45.51, zoom: 11, columns: 20, rows: 10 })
		expect(typeof frame.attribution).toBe("string")
	})
})
```

On the first run the snapshots are created; **eyeball them** — the z14 frame must show the road grid as bright dot lines and the label text; the z11 frame must show the earth fill stipple and water along the west edge. A blank or solid frame is a bug, not a baseline.

- [ ] **Step 2: Run to verify failure.** — FAIL (module not found).

- [ ] **Step 3: Implement `MapRenderer.renderFrame`.**

```
subpixelW = columns * 2; subpixelH = rows * 4
renderZoom = clamp(round(viewport.zoom), source.minZoom, source.maxZoom)
center = lonLatToWorldPx(centerLon, centerLat, renderZoom)
originX = center.x - subpixelW / 2; originY = center.y - subpixelH / 2   // world px of top-left subpixel
tile range: floor(originX / TILE_SIZE) .. floor((originX + subpixelW) / TILE_SIZE), same for y,
	each axis clamped to 0 .. 2**renderZoom - 1
fetch all tiles (Promise.all over source.getTile), skip nulls
three passes over (tile, layer, style) pairs in kind order: "fill", then "line", then "label":
	scale = TILE_SIZE / layer.extent
	project point: px = tileX * TILE_SIZE + g.x * scale - originX  (same for y)
	fill  → fillPolygon(grid, projectedRings, style.color)
	line  → drawPolyline(grid, projectedLine, style.color, style.width(renderZoom)) per geometry part
	label → collect { text: String(properties[style.property] ?? ""), column: round(px / 2), row: round(py / 4), color }
			for point features with non-empty text
ring overlay (before cells): radiusPx = ring.radiusMeters / metersPerPixel(ring.lat, renderZoom);
	drawCircle at the ring's projected px when radiusPx >= 2
frame = rasterizeToFrame(grid, columns, rows, source.attribution)
labels: occupied = new Uint8Array(columns * rows); overlayText each collected label (collision-skipped)
markers (after labels — markers win): overlayText WITHOUT the occupied bitmap at the projected cell,
	char marker.char ?? "●", color from RGB → 0xRRGGBB
return frame
```

Color packing helper: `rgbToPacked([r, g, b])` → `(r << 16) | (g << 8) | b` — define once in `frame.ts` and reuse.

- [ ] **Step 4: Run to verify pass; eyeball the new snapshots.** — PASS, snapshots reviewed by printing them: `yarn vitest run map-tui/renderer.test.ts` then read `map-tui/__snapshots__/renderer.test.ts.snap`.

- [ ] **Step 5: Wire `index.ts` re-exports; run the whole package.** `yarn vitest run map-tui/` — all green. `yarn lint` — green.

- [ ] **Step 6: Commit.** `map-tui: viewport renderer + golden frames`

---

## Part B — the debug view (`mailwoman` workspace)

### Task 9: Geocode session extraction (`geocode-session.ts`)

**Files:**

- Create: `mailwoman/geocode-session.ts`
- Modify: `mailwoman/commands/geocode.tsx` (`runGeocode` delegates to the session)
- Test: existing `mailwoman/commands/geocode.test.ts` — **must pass unmodified**

**Interfaces:**

- Consumes: everything `runGeocode` assembles today (`geocode.tsx:310-529`).
- Produces:

```ts
import type { AddressTree } from "@mailwoman/core" // the decoder AddressTree (nodes carry start/end char offsets)
import type { GeocodeResult } from "../geocode-core.ts"
export interface GeocodeRun {
	result: GeocodeResult
	tree: AddressTree
}
export interface GeocodeSession {
	geocode(input: string): Promise<GeocodeRun>
	close(): void
}
/** Options: the geocode command's parsed zod options object (same shape runGeocode receives). */
export async function createGeocodeSession(options: GeocodeSessionOptions): Promise<GeocodeSession>
```

`GeocodeSessionOptions` is a structural interface declared in `geocode-session.ts` (NOT derived from the command's zod schema — that would invert the import direction). It lists exactly the fields the session reads, with types copied from the schema: `locale`, `bias`, `defaultCountry`, `countryScope`, `resolveDB`, `candidateDB`, `dataRoot`, `addressPointsDB`, `interpolationDB`, `interpCalibration`, `localeCountryPrior`, `placeCountry`, `postcodeCountryCoherence`, `forkEntity`, `postcodeShapeCoherence`, `postcodeContainmentCoherence`, `placeCountryThreshold`. The command passes its whole parsed options object; structural typing accepts the superset.

- [ ] **Step 1: Move the assembly.** `createGeocodeSession` performs, in this order (preserving today's error precedence — gazetteer path first, weights second): `resolveCandidateDBPath` → `resolveWOFPath` → classifier load → `resolver-wof-sqlite` import → lookup/RegionDatabaseProvider/explicit-extract wiring → BAN/OSM optional providers → CoarsePlacer → `createWOFResolver` → parse the `--bias` string once. All of this is a cut-and-paste from `runGeocode` with `input`-dependent code left behind.

  `session.geocode(input)` performs the per-input work: `parseForGeocode` → the `barePostcodeFormatConflict` / `inferredScopeOK` / `withheldCountry` derivations → the fork-entity dep probe (hoist the `existsSync(poiDBPath)` + dynamic imports into `createGeocodeSession` so they run once; keep the `options.forkEntity !== false` gate) → `geocodeAddress(...)` with the exact dep spread `runGeocode` builds today → returns `{ result, tree: parsedTree }`.

  `close()`: the current `finally` block's five closes, each wrapped so one failure doesn't skip the rest.

- [ ] **Step 2: Delegate `runGeocode`.**

```ts
async function runGeocode(input: string, options: zod.infer<typeof OptionsSchema>): Promise<string> {
	const format = resolveFormat(options)
	const session = await createGeocodeSession(options)

	try {
		const { result } = await session.geocode(input)

		if (format === "text") return formatText(result)
		if (format === "jsonld") return JSON.stringify(geocodeToSchemaOrg(result), null, 2)

		return JSON.stringify(result, null, 2)
	} finally {
		session.close()
	}
}
```

- [ ] **Step 3: Run the regression gate.** `yarn compile && yarn vitest run mailwoman/commands/geocode.test.ts` — PASS with zero test-file edits. Also run one manual parity check against the compiled CLI if the lab data root is present: `node mailwoman/out/cli.js geocode "3215 SE Clinton St, Portland OR" > /tmp/claude-1000/-home-lab-Projects-mailwoman/*/scratchpad/after.json` and diff against the same command run from `git stash` state (byte-identical expected).

- [ ] **Step 4: Commit.** `geocode: extract the warm session from runGeocode`

### Task 10: Tiles path resolution (`$MAILWOMAN_TILES`)

**Files:**

- Modify: `core/env/schema.ts` — two lines: `MAILWOMAN_TILES: z.string().optional(),` in the DB-paths block, and `NO_COLOR: z.string().optional(),` (the informal-standard color kill switch; the schema strips unlisted vars, so it must be declared for `$public.NO_COLOR` to be readable — chalk/Ink honor it internally, but the debug map pane emits raw SGR and must consult it itself)
- Create: `mailwoman/debug-view/tiles.ts`, `mailwoman/debug-view/tiles.test.ts`

**Interfaces:**

- Produces:

```ts
/** --tiles flag → $MAILWOMAN_TILES → dataRootPath("tiles", "planet.pmtiles") if it exists → null (degrade). */
export function resolveTilesPath(flagValue?: string): string | null
```

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest"
import { resolveTilesPath } from "./tiles.ts"

describe("resolveTilesPath", () => {
	it("prefers the explicit flag", () => {
		expect(resolveTilesPath("/somewhere/planet.pmtiles")).toBe("/somewhere/planet.pmtiles")
	})

	it("returns null when nothing is configured and the data-root default is absent", () => {
		// The test env has no $MAILWOMAN_TILES; the data-root probe is existsSync-guarded.
		const resolved = resolveTilesPath()
		if (resolved != null) expect(resolved.endsWith("planet.pmtiles")).toBe(true)
	})
})
```

(The second assertion is environment-tolerant by design: on the lab host the data-root default may exist.)

- [ ] **Step 2: Run to verify failure, implement, re-run.**

```ts
import { existsSync } from "node:fs"
import { $public } from "@mailwoman/core/env"
import { dataRootPath } from "@mailwoman/core/utils"

export function resolveTilesPath(flagValue?: string): string | null {
	if (flagValue) return flagValue
	if ($public.MAILWOMAN_TILES) return $public.MAILWOMAN_TILES

	const fallback = String(dataRootPath("tiles", "planet.pmtiles"))

	return existsSync(fallback) ? fallback : null
}
```

- [ ] **Step 3: Lab convenience (manual, not in code):** `mkdir -p $MAILWOMAN_DATA_ROOT/tiles && ln -s /mnt/playpen/protomaps/20260521.pmtiles $MAILWOMAN_DATA_ROOT/tiles/planet.pmtiles` — record the command in the PR description, do not script it.

- [ ] **Step 4: Commit.** `geocode: tiles path resolution for the debug map pane`

### Task 11: Pure debug components (`DebugFrame`) + capture renderer

**Files:**

- Create: `mailwoman/debug-view/tag-colors.ts`, `mailwoman/debug-view/DebugFrame.tsx`, `mailwoman/debug-view/static-render.ts`, `mailwoman/debug-view/DebugFrame.test.ts`
- Modify: `mailwoman/package.json` (add `"@mailwoman/map-tui": "workspace:*"`, `"ink-text-input": "^6.0.0"`)

**Interfaces:**

- Consumes: `MapFrame` + `frameToANSILines` from `@mailwoman/map-tui`; `AddressTree`/`AddressNode` from `@mailwoman/core`; `GeocodeResult` from `../geocode-core.ts`.
- Produces:

```ts
// tag-colors.ts — background color per ComponentTag for the span ribbon; a Record with a
// default for unlisted tags. Hex strings (Ink accepts them):
export function tagColor(tag: string): string

// DebugFrame.tsx — the pure three-panel layout. No hooks that touch the terminal; everything from props.
export type DebugPane = "input" | "output" | "map"
export interface DebugData {
	input: string
	tree: AddressTree
	result: GeocodeResult
	frame: MapFrame | null
	/** Shown in the map pane when frame is null: "no tiles: …" or "unresolved: no coordinate". */
	mapNote: string | null
}
export interface DebugFrameProps {
	data: DebugData
	columns: number
	rows: number
	/** null = static render (no focus chrome). */
	focused: DebugPane | null
	/** Interactive-only children slot for the input row (the text field); static passes undefined and the input renders as plain text. */
	inputField?: React.ReactNode
	busy?: boolean
	/** Map-pane SGR color. Callers pass `$public.NO_COLOR == null` — Ink/chalk honor NO_COLOR on their own, raw SGR does not. */
	color: boolean
}
export function DebugFrame(props: DebugFrameProps): React.ReactElement

// static-render.ts — render any Ink tree once to a string (doubles as the component-test harness).
export function renderInkToString(tree: React.ReactElement, columns: number): Promise<string>
```

- [ ] **Step 1: Implement `renderInkToString` first** (the tests need it):

```ts
import { EventEmitter } from "node:events"
import { render } from "ink"

class CaptureStream extends EventEmitter {
	readonly frames: string[] = []
	columns: number
	readonly isTTY = false

	constructor(columns: number) {
		super()
		this.columns = columns
	}

	write(chunk: string): boolean {
		this.frames.push(chunk)

		return true
	}
}

export async function renderInkToString(tree: React.ReactElement, columns: number): Promise<string> {
	const stdout = new CaptureStream(columns)
	const instance = render(tree, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		patchConsole: false,
		exitOnCtrlC: false,
	})

	instance.unmount()

	return stdout.frames.at(-1) ?? ""
}
```

The tree is pure and synchronous, so the mount frame is final and `unmount()` fires immediately. If Ink's non-TTY mode defers the final write past `unmount` (the first test's non-empty assertion will say so), insert `await new Promise((r) => setImmediate(r))` before reading the frames — that is the only sanctioned adjustment.

- [ ] **Step 2: Write the failing component tests.**

```ts
import { describe, expect, it } from "vitest"
import React from "react"
import { DebugFrame } from "./DebugFrame.tsx"
import { renderInkToString } from "./static-render.ts"

const TREE = {
	raw: "3215 SE Clinton St, Portland OR",
	roots: [
		{ tag: "house_number", value: "3215", start: 0, end: 4, confidence: 0.99, children: [] },
		{ tag: "street", value: "SE Clinton St", start: 5, end: 18, confidence: 0.98, children: [] },
		{ tag: "locality", value: "Portland", start: 20, end: 28, confidence: 0.97, children: [] },
		{ tag: "region", value: "OR", start: 29, end: 31, confidence: 0.96, children: [] },
	],
} as never

const RESULT = {
	input: "3215 SE Clinton St, Portland OR",
	lat: 45.5034,
	lon: -122.6023,
	resolution_tier: "address_point",
	uncertainty_m: 8,
	locality: "Portland",
	region: "Oregon",
	postcode: null,
	house_number: "3215",
	street: "SE Clinton St",
	hierarchy: [{ tag: "locality", value: "Portland", placeID: "wof:101715829", lat: 45.52, lon: -122.67 }],
	candidates: [],
	components: {},
	venue: null,
	dependent_locality: null,
} as never

describe("DebugFrame", () => {
	it("renders all three panes with the parse and the resolution", async () => {
		const text = await renderInkToString(
			<DebugFrame
				columns={100}
				rows={30}
				focused={null}
				color={true}
				data={{ input: RESULT.input, tree: TREE, result: RESULT, frame: null, mapNote: "no tiles: set $MAILWOMAN_TILES or --tiles" }}
			/>,
			100
		)
		expect(text).toContain("3215 SE Clinton St")
		expect(text).toContain("address_point")
		expect(text).toContain("45.5034")
		expect(text).toContain("no tiles")
	})

	it("marks the focused pane", async () => {
		const focusedText = await renderInkToString(
			<DebugFrame columns={100} rows={30} focused="map" color={true} data={{ input: RESULT.input, tree: TREE, result: RESULT, frame: null, mapNote: null }} />,
			100
		)
		expect(focusedText).toContain("map") // focused pane title is highlighted + suffixed, e.g. "map ◀"
	})
})
```

(Test file extension: `.test.tsx` if JSX in tests requires it — follow `geocode.test.ts`'s pattern for imports; adjust filename accordingly.)

- [ ] **Step 3: Run to verify failure.** `yarn vitest run mailwoman/debug-view/` — FAIL.

- [ ] **Step 4: Implement `tag-colors.ts` and `DebugFrame.tsx`.** Layout arithmetic is explicit (no post-hoc measurement): input row height 4 (border + input line + ribbon); bottom row height `rows - 4`; output pane width `floor(columns / 2)`, map pane the remainder. The map pane's _cell_ budget for the renderer is `mapPaneWidth - 2` × `rows - 4 - 2` (borders) — export a helper so the command can size the renderer viewport:

```ts
export function mapPaneCellSize(columns: number, rows: number): { columns: number; rows: number } {
	return { columns: columns - Math.floor(columns / 2) - 2, rows: rows - 4 - 2 }
}
```

Panes: `<Box borderStyle="round" borderColor={focused === pane ? "cyan" : "gray"}>` with a `<Text>` title. InputBar: `inputField` child when provided, else `<Text>{data.input}</Text>`; beneath it the ribbon — walk the tree's leaf nodes sorted by `start`, emit `<Text backgroundColor={tagColor(node.tag)}> {value} </Text>` segments plus a legend line of `tag` names in their colors. OutputPane: tier/coordinate/uncertainty lines + one row per `result.hierarchy` entry (`tag` in its ribbon color, value, placeID dim, coord dim). MapPane: `frame` present → `frameToANSILines(frame, { color: props.color }).map((line, i) => <Text key={i}>{line}</Text>)` + attribution right-aligned dim; else `<Text dimColor>{mapNote}</Text>`. Busy: title suffix `…` on the output pane.

- [ ] **Step 5: Run to verify pass.** — PASS.

- [ ] **Step 6: Commit.** `geocode: pure DebugFrame components + capture renderer`

### Task 12: `--debug` static path (non-TTY)

**Files:**

- Modify: `mailwoman/commands/geocode.tsx` (options schema + command component branch)
- Create: `mailwoman/debug-view/command.tsx`, `mailwoman/debug-view/static.test.ts`

**Interfaces:**

- Consumes: `createGeocodeSession`, `resolveTilesPath`, `DebugFrame`, `renderInkToString`, `mapPaneCellSize`, map-tui's `TileSource`/`MapRenderer`.
- Produces:

```ts
// command.tsx
export function GeocodeDebugCommand(props: { input: string; options: GeocodeCommandOptions }): React.ReactElement
// internal: runStaticDebug(input, options) → Promise<string>  (the captured frame)
export function initialZoomForTier(result: GeocodeResult): number
```

- [ ] **Step 1: Extend the options schema** in `geocode.tsx`:

```ts
debug: zod.boolean().optional().default(false).describe(
	"Interactive three-panel debug view (input / parse+resolution / map) on a TTY; " +
		"a single rendered frame on a pipe. Not combinable with --json/--text/--jsonld."
),
debugSize: zod.string().regex(/^\d+x\d+$/u, "Expected COLSxROWS, e.g. 120x36").optional().default("120x36")
	.describe("Frame size for the non-TTY --debug render. Ignored on a TTY (the terminal sizes the view)."),
tiles: zod.string().optional().describe(
	"PMTiles archive for the --debug map pane. Defaults to $MAILWOMAN_TILES, then " +
		"<dataRoot>/tiles/planet.pmtiles when present. Absent tiles degrade the pane to a note."
),
```

- [ ] **Step 2: Branch the command component.** Export the options type from `geocode.tsx` so the debug module can name it: `export type GeocodeCommandOptions = zod.infer<typeof OptionsSchema>`. Then move the existing `GeocodeCommand` body into a `GeocodeOneShot` component and make `GeocodeCommand` a pure hook-free dispatcher, so each branch's hooks stay unconditional:

```tsx
const GeocodeCommand: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) =>
	options.debug ? (
		<GeocodeDebugCommand input={(args[0] ?? "").trim()} options={options} />
	) : (
		<GeocodeOneShot args={args} options={options} />
	)
```

The `--debug` + format-shorthand conflict check lives INSIDE `GeocodeDebugCommand`'s async task (first statement), thrown as `commandError` — so it reports through the standard error state and carries exit code 1 like every other usage error, on both the static and interactive paths:

```ts
function assertDebugFormatSanity(options: GeocodeCommandOptions): void {
	const shorthands = (["json", "text", "jsonld"] as const).filter((name) => options[name])

	if (shorthands.length > 0) {
		throw commandError(`--debug is its own output surface; drop ${shorthands.map((name) => `--${name}`).join(" ")}.`)
	}
}
```

- [ ] **Step 3: Implement the static path in `command.tsx`.**

```tsx
export function initialZoomForTier(result: GeocodeResult): number {
	if (result.resolution_tier === "address_point" || result.resolution_tier === "interpolated") return 15

	const leaf = result.hierarchy.at(-1)?.tag

	if (leaf === "locality" || leaf === "dependent_locality") return 11
	if (leaf === "region") return 6

	return 4
}

async function runStaticDebug(input: string, options: GeocodeCommandOptions): Promise<string> {
	assertDebugFormatSanity(options)

	const [columns, rows] = options.debugSize.split("x").map(Number) as [number, number]
	const session = await createGeocodeSession(options)

	try {
		const { result, tree } = await session.geocode(input)
		const tilesPath = resolveTilesPath(options.tiles)
		let frame = null
		let mapNote: string | null = null

		if (result.lat == null || result.lon == null) {
			mapNote = "unresolved: no coordinate"
		} else if (tilesPath == null) {
			mapNote = "no tiles: set $MAILWOMAN_TILES or --tiles"
		} else {
			const source = await TileSource.open(tilesPath)

			try {
				const pane = mapPaneCellSize(columns, rows)
				const renderer = new MapRenderer(source)

				frame = await renderer.renderFrame(
					{
						centerLon: result.lon,
						centerLat: result.lat,
						zoom: initialZoomForTier(result),
						columns: pane.columns,
						rows: pane.rows,
					},
					{
						markers: [{ lon: result.lon, lat: result.lat }],
						...(result.uncertainty_m != null
							? { ring: { lon: result.lon, lat: result.lat, radiusMeters: result.uncertainty_m } }
							: {}),
					}
				)
			} finally {
				await source.close()
			}
		}

		return renderInkToString(
			<DebugFrame
				columns={columns}
				rows={rows}
				focused={null}
				color={$public.NO_COLOR == null}
				data={{ input, tree, result, frame, mapNote }}
			/>,
			columns
		)
	} finally {
		session.close()
	}
}
```

`GeocodeDebugCommand` (static half; interactive lands in Task 13): when `!process.stdout.isTTY`, `useCommandTask(() => runStaticDebug(input, options))` → on done `writeRawStdout(state.result)`, on error the red `<Text>`; running renders `null` (the #1577 posture). When `process.stdout.isTTY`, render a placeholder `<Text>` ("interactive session lands in the next commit") — replaced by Task 13.

- [ ] **Step 4: Write the guarded smoke test** (`static.test.ts`): skip (`describe.skipIf`) unless the weights + a resolver DB resolve (mirror how `geocode.test.ts` guards its environment — read its guard and reuse the same predicate). Body: run `runStaticDebug("3215 SE Clinton St, Portland OR", …)` with `tiles` pointed at `map-tui/test/fixtures/portland.pmtiles` and `debugSize: "100x30"`; assert the string contains `"address_point"` or `"admin"` (tier line), a `⠀`-range braille char or the marker `●`, and the input echoed.

- [ ] **Step 5: Run.** `yarn compile && yarn vitest run mailwoman/debug-view/` — PASS (smoke skipped or green per environment). Manual receipt on the lab host: `node mailwoman/out/cli.js geocode "3215 SE Clinton St, Portland OR" --debug | head -40` shows the frame.

- [ ] **Step 6: Commit.** `geocode: --debug static frame for pipes + skills`

### Task 13: Interactive session

**Files:**

- Create: `mailwoman/debug-view/DebugSessionApp.tsx`
- Modify: `mailwoman/debug-view/command.tsx` (TTY branch renders the app)

**Interfaces:**

- Consumes: everything above plus `ink-text-input` and Ink's `useInput`/`useApp`/`useStdout`.
- Produces: `export function DebugSessionApp(props: { initialInput: string; options: GeocodeCommandOptions }): React.ReactElement`

- [ ] **Step 1: Implement the state shell.** One component owning:

```
phase: "loading" | "ready" | "busy" | "fatal"
session (created in a mount effect; closed in cleanup)
tileSource + renderer (opened in the same effect when resolveTilesPath finds a path)
data: DebugData | null
focused: DebugPane (initial "input")
inputValue: string
viewport override: { centerLon, centerLat, zoom } | null   // null = follow the result
frameRequestID counter                                      // stale async frame guard
terminal size: { columns, rows } from useStdout(), updated on stdout "resize" events
```

The mount effect's first statement is `assertDebugFormatSanity(options)` (a throw lands in the `fatal` phase, message rendered red, exit code 1). `DebugFrame` receives `color={$public.NO_COLOR == null}`, same as the static path.

Alternate screen: mount effect writes `"[?1049h"` to stdout, cleanup writes `"[?1049l"`; the loading frame ("loading model…") is the only pre-alt-screen flash.

Frame effect: on `[data?.result, viewportOverride, size]` change and renderer present → compute pane cells via `mapPaneCellSize`, `renderFrame` with marker + ring, guard with the request counter, `setFrame`.

- [ ] **Step 2: Key handling** (`useInput`, active whenever phase is not "loading"):

```
Tab              → focused = next of ["input", "output", "map"] (wraps)
Esc              → exit() (useApp), after cleanup restores the main screen
"q"              → exit() unless focused === "input"
focused "map":   arrows pan by (columns/8 cells * 2)px x / (rows/8 * 4)px y; "+"/"=" zoom in, "-" zoom out
                  (clamped to source zoom bounds); "0" clears viewportOverride
focused "output": up/down scroll offset (slice the hierarchy rows)
```

Input row: `<TextInput value={inputValue} onChange focus={focused === "input"} onSubmit={submit}/>` where `submit` sets busy, `session.geocode(inputValue)`, replaces `data`, clears `viewportOverride`, returns to ready; a thrown error renders in the output pane (message row, red) with the previous result retained.

- [ ] **Step 3: Wire the TTY branch** in `command.tsx`: replace the Task 12 placeholder with `<DebugSessionApp initialInput={input} options={options} />`.

- [ ] **Step 4: Manual verification on the lab host** (interactive TUIs get a human eye, not a unit test): `yarn compile && node mailwoman/out/cli.js geocode "3215 SE Clinton St, Portland OR" --debug` with `$MAILWOMAN_TILES` set to the planet symlink. Check: three panels render; map shows Portland; Tab cycles focus; arrows pan; `+`/`-` zoom; editing the input to `"350 5th Ave, New York, NY"` + Enter re-renders all panes in ~a second; Esc restores the terminal with scrollback intact (`echo before-run` printed before the session must still be in scrollback after exit). Record observations in the PR.

- [ ] **Step 5: Re-run the pure-component tests** (`yarn vitest run mailwoman/debug-view/ mailwoman/commands/geocode.test.ts`) — PASS.

- [ ] **Step 6: Commit.** `geocode: interactive --debug session (pan/zoom/edit/re-run)`

### Task 14: Release + docs wiring

**Files:**

- Modify: `.release-it.json` (add `map-tui` to the workspaces publish list, matching its ordering), `AGENTS.md` (workspace table + counts), `docs/engineering/SCOPE.mdx` only if it enumerates workspaces (check; skip if not)

- [ ] **Step 1: `.release-it.json`.** Add `map-tui` to the `@release-it-plugins/workspaces` list. The publish count becomes 49 of 55.

- [ ] **Step 2: `AGENTS.md`.** Update the header arithmetic ("53 scoped workspaces / 54 entries" → "54 scoped / 55 entries"; "48 of the 54 publish" → "49 of the 55"; the "4 private + 1 held out = 5" sentence stands). Add the table row under **Client + UI**:

```
| `map-tui/` | `@mailwoman/map-tui` | Terminal vector-tile map renderer — braille `MapFrame` values from PMTiles (asciify-based); powers the `mw geocode --debug` map pane. Frame-first: consumers own presentation |
```

- [ ] **Step 3: First-publish note.** Add one line to the PR description (not to committed docs): `@mailwoman/map-tui` is a NEW package — the first publish cannot use Trusted Publishing OIDC (the v8.4.0 first-publish gap); run the manual bless path once before the release that ships this.

- [ ] **Step 4: Full verification sweep.** `yarn lint && yarn compile && yarn vitest run map-tui/ mailwoman/debug-view/ mailwoman/commands/geocode.test.ts` — all green. `git status` clean of strays.

- [ ] **Step 5: Commit.** `map-tui: join the publish set + workspace table`

---

## Deviations from the spec (recorded, approved direction)

1. **No `@mailwoman/spatial` dependency in map-tui.** The uncertainty ring needs only `metersPerPixel` (ground resolution), not haversine; cartographer/spatial both drag heavy transitive deps (maplibre-gl + tiger; core's shipped data). map-tui carries a local 40-line `mercator.ts` with the priced-and-declined note — the `nuts-lookup` precedent. Net: zero `@mailwoman/*` runtime deps, which also serves the phase-2 standalone `npx` story.
2. **No `ink-testing-library`.** `renderInkToString` (Task 11) is both the static-path mechanism and the component-test harness — one less dev dep, and the test exercises the production capture path.
3. **No graticule in the tile-less map pane.** Spec §3's degrade shape ("marker on a graticule") shipped as the note alone; the graticule is deferred to phase 2 with the standalone browser.
4. **Fixed 12-px pan step.** The interactive pan step is a constant 12 device pixels per keypress (6 cells horizontal, 3 vertical), not the terminal-proportional step the plan sketched — same physical nudge at every terminal size.

## Explicitly out of scope (phase 2+)

The standalone `npx map-tui` browser bin, unscoped npm name reservation, HTTP tile sources, fresh tippecanoe tilesets, full pipeline stage trace, output-pane candidate drill-down.
