# Astrogeology Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private workspace, `packages/astrogeology`, that turns the USGS nomenclature gazetteer and the LOLA and MOLA global DEMs into `moon.pmtiles`, `moon-hillshade.pmtiles`, `mars.pmtiles`, `mars-hillshade.pmtiles`, a search artifact per body and a build manifest with checksums, and publishes them through `mailwoman tiles publish`. CI builds the same chain over tiny fixtures with no network.

**Architecture:** Fetchers under `lib/sdk/` cache pinned sources under `$MAILWOMAN_DATA_ROOT/astrogeology/<body>/source/`. `normalize.ts` turns a source row into a `PlanetaryNomenclatureFeature` with east-positive longitude in −180..180, a bounding box that survives the 0/360 wrap, and the stable id from the source's `link` column. The vector build writes NDJSON with tippecanoe hints and runs `tippecanoe`; the hillshade build runs `gdaldem` on the source grid with the body's metres-per-degree, then warps the shaded image for XYZ tiling and converts MBTiles to PMTiles with `pmtiles convert`. `pmtiles edit` injects the `mailwoman:*` metadata. A `zod` manifest is the reproducibility record. `@mailwoman/spatial` gains a body radius before any distance is computed.

**Tech Stack:** TypeScript under Node; `zod`; GDAL (`ogr2ogr`, `gdaldem`, `gdalwarp`, `gdal_translate`, `gdaladdo`), `tippecanoe` 2.80, the `pmtiles` CLI, all present on the lab; `@mailwoman/ancestrie` for the search artifact; `mailwoman/cli-kit` for the bin; vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-astrogeology-pipeline-design.md`

## Global Constraints

- `packages/astrogeology`, `@mailwoman/astrogeology`, `private: true`, registered in the root `workspaces`, both `tsconfig.json` reference entries, and `SANCTIONED_RELEASE_ABSENCES` ("private planetary data pipeline — no published consumer yet"). `publishCount` stays 60.
- Fetchers live in `lib/sdk/`; DEM downloads stream to disk with raw `fetch` (a file transfer, never `APIClient`).
- Filesystem work through `@mailwoman/core/fs`; paths through `path-ts` and `dataRootPath("astrogeology", …)`; processes through `runFile` from `@mailwoman/core/process`. No `node:*` import, no `process.env`, no `zx`.
- Coordinates in every emitted artifact: east-positive longitude in [−180, 180], latitude in [−90, 90]; the source convention is recorded in the manifest, never inferred in a consumer.
- No pin drifts silently: a cached source whose size or SHA-256 differs from the lock file fails the build naming both values.
- A test imports the package through its public exports; every module a test names gets an `exports` entry.
- The fixture build runs under `test/integration/` (the `unit-slow` leg runs on the lab's self-hosted runners, which carry GDAL, tippecanoe and pmtiles; a missing tool fails the test with the tool's name).
- Comments state invariants; the measurements below go in the source table, not in prose.
- Branch: `git fetch origin main && git checkout -b feat/astrogeology origin/main`.

## Sources, measured 2026-09-07

| Source                                 | URL                                                                                           | Bytes         | Last-Modified        | Notes                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Moon nomenclature (center points, SHP) | `https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip` | 23,842,450    | regenerated nightly  | 9,086 points; lon 0.0039..359.9936; `GCS_Moon_2000`, sphere 1,737,400 m; control network LOLA 2011; public domain (`<useconst>`) |
| Mars nomenclature (center points, SHP) | `https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.zip` | 5,413,387     | regenerated nightly  | 2,052 points; lon 0.0014..360.0; `GCS_Mars_2000`, ellipsoid 3,396,190 m, 1/f 169.894; control network MDIM 2.1; public domain    |
| LOLA global DEM, 118 m                 | `https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif`           | 8,494,203,833 | 2022-11-08T23:01:12Z | GeoTIFF, redirects once (follow)                                                                                                 |
| MOLA global DEM, 463 m                 | `https://planetarymaps.usgs.gov/mosaic/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif`              | 2,125,771,142 | 2022-11-10T03:31:07Z | GeoTIFF, redirects once (follow)                                                                                                 |

Nomenclature columns (both bodies): `name`, `clean_name`, `approvaldt` (`YYYY/MM/DD HH:MM:SS`), `origin`, `diameter` (km), `center_lon`, `center_lat`, `type` (`Crater, craters`, `Mons, montes`, `Satellite Feature`, …), `code` (`AA`, `MO`, `SF`, …), `approval` (`Adopted by IAU`), `min_lon`, `max_lon`, `min_lat`, `max_lat`, `ethnicity`, `continent`, `quad_name`, `quad_code`, `link` (`http://planetarynames.wr.usgs.gov/Feature/<id>`). Three rows the fixtures reuse verbatim: Marco Polo P (id 11150, lon 359.6815, bbox 359.1977..360.1643, `SF`), Tycho (lon 348.7847, lat −43.2958, diameter 85.29, `AA`), Olympus Mons (id from its link, lon 226.1975, lat 18.6528, diameter 610.13, `MO`).

The nomenclature is regenerated nightly, so it is pinned by SNAPSHOT: `astrogeology fetch --body moon` downloads today's archive to `source/nomenclature-<YYYY-MM-DD>.zip`, records its SHA-256 and byte count in `sources.lock.json`, and the build reads only the locked snapshot. The DEMs are stable products, pinned by URL, byte count and SHA-256 (the SHA-256 is written by the first fetch and refused on change thereafter).

## File Structure

```text
packages/astrogeology/
  package.json                @mailwoman/astrogeology, private, bin astrogeology → out/cli.js
  tsconfig.json, tsconfig.test.json, README.md
  sources.lock.json           the pins; committed; written by `fetch`
  lib/
    cli.ts                    the bin: fetch | build | verify | publish
    bodies.ts                 PlanetaryBody records and the id union            (tested)
    normalize.ts              longitude, bbox, id, date, feature projection      (tested)
    schema/nomenclature.ts    PlanetaryNomenclatureFeature (zod)                 (tested)
    schema/manifest.ts        PlanetaryBuildManifest, SourcesLock (zod)          (tested)
    schema/pmtiles-metadata.ts the mailwoman:* block (zod)                       (tested)
    sdk/sources.ts            the source table above, typed
    sdk/fetch.ts              downloadPinned(), lock read/write
    build/nomenclature.ts     shapefile → features → NDJSON → tippecanoe → PMTiles
    build/hillshade.ts        DEM → gdaldem → warp → MBTiles → PMTiles
    build/search-index.ts     features → ancestrie artifact
    build/metadata.ts         pmtiles edit with the validated block
    build/manifest.ts         emit manifest.json with checksums
    commands/{fetch,build,verify,publish}.tsx
  test/
    unit/{bodies,normalize,schema}.test.ts
    integration/fixture-build.test.ts
    fixtures/moon-nomenclature.ndjson   five features
    fixtures/mars-nomenclature.ndjson   three features
    fixtures/dem-64.tif                 synthetic, generated once by `gdal_create`, committed (≈10 KB)

packages/spatial/lib/distance.ts        BODY_RADII_KM, greatCircleDistance with a radius option
packages/mailwoman/lib/tiles/publish.ts  publishTiles moves here from the command file; exported as mailwoman/tiles/publish
```

---

### Task 1: The workspace, its registers, and the body radius in `@mailwoman/spatial`

**Files:**

- Create: `packages/astrogeology/package.json`, `tsconfig.json`, `tsconfig.test.json`, `README.md`
- Modify: root `package.json`, root `tsconfig.json`, `packages/release-kit/lib/release/stage.ts`
- Modify: `packages/spatial/lib/distance.ts`; test `packages/spatial/test/unit/distance.test.ts` (or the file that tests `haversine` today: `grep -rln "haversine" packages/spatial/test`)

**Interfaces:**

- Produces: `@mailwoman/spatial` exports `BODY_RADII_KM: { earth: 6371, moon: 1737.4, mars: 3389.5 }`, `PlanetaryBodyID = "earth" | "moon" | "mars"`, and `greatCircleDistance(a, b, options: { unit?: EarthRadiusUnit; body?: PlanetaryBodyID })`. `haversine` and `haversineKm` keep their signatures and Earth semantics.

- [ ] **Step 1: The spatial test first**

Append to spatial's distance test:

```ts
test("greatCircleDistance takes the body radius: a quarter turn on the Moon is πR/2", () => {
	const quarter = greatCircleDistance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 }, { body: "moon" })
	expect(quarter).toBeCloseTo((Math.PI * 1737.4) / 2, 3)
	expect(greatCircleDistance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 })).toBeCloseTo(
		haversine({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 }),
		9
	)
})
```

Run `yarn vitest --run --config vitest.fast.config.ts packages/spatial/test`; expected: fails on the missing export.

- [ ] **Step 2: The spatial change**

In `packages/spatial/lib/distance.ts`, beside `RADII`:

```ts
export type PlanetaryBodyID = "earth" | "moon" | "mars"

/**
 * Mean radii in kilometres. Earth's is the value `RADII` scales to its units; the Moon's and Mars's are the IAU mean
 * radii the USGS planetary products reference (the Moon as a sphere; Mars's mean radius, its DEM being on the
 * areoid). A distance on a body other than Earth is meaningless without one of these.
 */
export const BODY_RADII_KM = {
	earth: RADII.km,
	moon: 1737.4,
	mars: 3389.5,
} as const satisfies Record<PlanetaryBodyID, number>

export interface GreatCircleOptions {
	unit?: EarthRadiusUnit
	/**
	 * Which body's mean radius scales the arc. @default "earth"
	 */
	body?: PlanetaryBodyID
}

/**
 * Great-circle distance on the named body. `haversine` is this function on Earth; a caller with a body passes it here.
 */
export function greatCircleDistance(
	point1: GeoPointInput,
	point2: GeoPointInput,
	options: GreatCircleOptions = {}
): number {
	const unit = options.unit ?? "km"
	const body = options.body ?? "earth"
	const scale = BODY_RADII_KM[body] / BODY_RADII_KM.earth

	return haversine(point1, point2, unit) * scale
}
```

`prefer-home` reports an Earth radius typed outside `@mailwoman/spatial`; both new literals are inside it. Export the three names from `packages/spatial/lib/index.ts`. Run the spatial tests; expected: pass.

- [ ] **Step 3: The workspace manifest**

`packages/astrogeology/package.json`:

```json
{
	"name": "@mailwoman/astrogeology",
	"version": "1.0.0",
	"private": true,
	"description": "USGS Astrogeology products (the planetary nomenclature gazetteer, the LOLA and MOLA global DEMs) built into PMTiles, search artifacts and manifests for the Moon and Mars maps.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"contributors": [{ "name": "Teffen Ellis", "email": "teffen@sister.software" }],
	"type": "module",
	"bin": { "astrogeology": "./out/cli.js" },
	"imports": {
		"#*": { "node": "./lib/*.ts", "default": "./out/*.js", "types": "./out/*.d.ts" }
	},
	"exports": {
		"./package.json": "./package.json",
		"./bodies": { "node": "./lib/bodies.ts", "default": "./out/bodies.js", "types": "./out/bodies.d.ts" },
		"./normalize": { "node": "./lib/normalize.ts", "default": "./out/normalize.js", "types": "./out/normalize.d.ts" },
		"./schema/nomenclature": {
			"node": "./lib/schema/nomenclature.ts",
			"default": "./out/schema/nomenclature.js",
			"types": "./out/schema/nomenclature.d.ts"
		},
		"./schema/manifest": {
			"node": "./lib/schema/manifest.ts",
			"default": "./out/schema/manifest.js",
			"types": "./out/schema/manifest.d.ts"
		},
		"./schema/pmtiles-metadata": {
			"node": "./lib/schema/pmtiles-metadata.ts",
			"default": "./out/schema/pmtiles-metadata.js",
			"types": "./out/schema/pmtiles-metadata.d.ts"
		},
		"./build/nomenclature": {
			"node": "./lib/build/nomenclature.ts",
			"default": "./out/build/nomenclature.js",
			"types": "./out/build/nomenclature.d.ts"
		},
		"./build/hillshade": {
			"node": "./lib/build/hillshade.ts",
			"default": "./out/build/hillshade.js",
			"types": "./out/build/hillshade.d.ts"
		},
		"./build/search-index": {
			"node": "./lib/build/search-index.ts",
			"default": "./out/build/search-index.js",
			"types": "./out/build/search-index.d.ts"
		},
		"./build/metadata": {
			"node": "./lib/build/metadata.ts",
			"default": "./out/build/metadata.js",
			"types": "./out/build/metadata.d.ts"
		},
		"./build/manifest": {
			"node": "./lib/build/manifest.ts",
			"default": "./out/build/manifest.js",
			"types": "./out/build/manifest.d.ts"
		}
	},
	"dependencies": {
		"@mailwoman/ancestrie": "workspace:*",
		"@mailwoman/core": "workspace:*",
		"@mailwoman/spatial": "workspace:*",
		"mailwoman": "workspace:*",
		"path-ts": "^2.3.0",
		"zod": "<the range packages/resolver-wof-wasm/package.json declares>"
	},
	"engines": { "node": ">=24.18.0" }
}
```

`tsconfig.json` follows `packages/tile-worker/tsconfig.json` without the workers types, with references `../core`, `../spatial`, `../ancestrie`, `../mailwoman`; `tsconfig.test.json` follows `packages/license-worker/tsconfig.test.json` without the types line. Registers: root `workspaces` (alphabetical, after `packages/api-kit`), root `tsconfig.json` (two entries), `SANCTIONED_RELEASE_ABSENCES` with `"packages/astrogeology": "private planetary data pipeline — no published consumer yet"`.

- [ ] **Step 4: Install, check, commit**

```bash
yarn install
node -e "const w=require('./package.json').workspaces,r=require('./.release-it.json').plugins['@release-it-plugins/workspaces'].workspaces;console.log(w.filter(x=>!r.includes(x)).length)"
yarn vitest --run --config vitest.slow.config.ts packages/release-kit/test/integration/release-stage.test.ts
git add package.json yarn.lock tsconfig.json packages/astrogeology packages/spatial packages/release-kit
git commit -m "feat(astrogeology): the workspace and its registers; spatial takes a body radius"
```

Expected: the absence count is one more than before this branch; `publishCount` stays 60.

---

### Task 2: Bodies, the feature schema, normalization — test-first

**Files:**

- Create: `lib/bodies.ts`, `lib/schema/nomenclature.ts`, `lib/normalize.ts`
- Test: `test/unit/bodies.test.ts`, `test/unit/schema.test.ts`, `test/unit/normalize.test.ts`

**Interfaces:**

- Produces: `PlanetaryBody` records `BODIES.moon`, `BODIES.mars` with `id`, `name`, `iauTargetName`, `meanRadiusKm` (from `BODY_RADII_KM`), `shape: "sphere" | "ellipsoid"`, `coordinates: PlanetaryCoordinateMetadata` (`longitudeDirection: "east"`, `longitudeRange: "0..360"`, `latitudeType: "planetocentric"`, `referenceBody`, `controlNetwork`), `metresPerDegree` (2πR/360, in metres: Moon 30,323.0, Mars 59,159.1 from the mean radius); `normalizeLongitude(lon): number`; `normalizeBBox({ minLon, maxLon, minLat, maxLat }): BBox` (wrap-aware); `featureIDFromLink(link): string`; `approvalDateFromSource("2006/01/01 00:00:00"): "2006-01-01"`; `featureFromSourceRow(body, row): PlanetaryNomenclatureFeature`; the zod `PlanetaryNomenclatureFeatureSchema`.

- [ ] **Step 1: Tests**

`test/unit/normalize.test.ts`:

```ts
import {
	approvalDateFromSource,
	featureFromSourceRow,
	featureIDFromLink,
	normalizeBBox,
	normalizeLongitude,
} from "@mailwoman/astrogeology/normalize"
import { describe, expect, test } from "vitest"

describe("normalizeLongitude", () => {
	test.each([
		[0, 0],
		[180, 180],
		[180.0001, -179.9999],
		[359.6815, -0.3185],
		[360, 0],
		[226.1975, -133.8025],
	])("%s → %s", (input, expected) => {
		expect(normalizeLongitude(input)).toBeCloseTo(expected, 6)
	})

	test("refuses a longitude outside 0..360 and -180..180", () => {
		expect(() => normalizeLongitude(361)).toThrow(/longitude/u)
		expect(() => normalizeLongitude(-181)).toThrow(/longitude/u)
	})
})

describe("normalizeBBox", () => {
	test("a box straddling 360 stays narrow (Marco Polo P)", () => {
		const box = normalizeBBox({ minLon: 359.1977, maxLon: 360.1643, minLat: 16.5046, maxLat: 17.4301 })
		expect(box.minLon).toBeCloseTo(-0.8023, 4)
		expect(box.maxLon).toBeCloseTo(0.1643, 4)
		expect(box.maxLon - box.minLon).toBeLessThan(1)
	})

	test("a box straddling 180 keeps its width and marks the antimeridian", () => {
		const box = normalizeBBox({ minLon: 178, maxLon: 182, minLat: -1, maxLat: 1 })
		expect(box.crossesAntimeridian).toBe(true)
		expect(box.minLon).toBeCloseTo(178, 6)
		expect(box.maxLon).toBeCloseTo(-178, 6)
	})

	test("a polar box clamps latitude to ±90", () => {
		expect(normalizeBBox({ minLon: 10, maxLon: 20, minLat: 88, maxLat: 90.4 }).maxLat).toBe(90)
	})
})

test("featureIDFromLink reads the trailing id", () => {
	expect(featureIDFromLink("http://planetarynames.wr.usgs.gov/Feature/11150")).toBe("11150")
	expect(() => featureIDFromLink("http://planetarynames.wr.usgs.gov/")).toThrow(/link/u)
})

test("approvalDateFromSource keeps the date and drops the zero time", () => {
	expect(approvalDateFromSource("2006/01/01 00:00:00")).toBe("2006-01-01")
	expect(approvalDateFromSource("")).toBeUndefined()
})

test("featureFromSourceRow projects Tycho", () => {
	const feature = featureFromSourceRow("moon", {
		name: "Tycho",
		clean_name: "Tycho",
		approvaldt: "1935/01/01 00:00:00",
		origin: "",
		diameter: 85.29377,
		center_lon: 348.7847,
		center_lat: -43.2958,
		type: "Crater, craters",
		code: "AA",
		approval: "Adopted by IAU",
		min_lon: 346.8521,
		max_lon: 350.7172,
		min_lat: -45.2,
		min_lat_unused: 0,
		max_lat: -41.4,
		quad_name: "Tycho",
		quad_code: "LAC-112",
		link: "http://planetarynames.wr.usgs.gov/Feature/6163",
		ethnicity: "",
		continent: "",
	})
	expect(feature).toMatchObject({
		id: "6163",
		body: "moon",
		name: "Tycho",
		featureType: "Crater, craters",
		featureTypeCode: "AA",
		diameterKm: 85.29377,
		approvalStatus: "Adopted by IAU",
		approvalDate: "1935-01-01",
		source: "usgs-iau",
	})
	expect(feature.centerLon).toBeCloseTo(-11.2153, 4)
	expect(feature.centerLat).toBeCloseTo(-43.2958, 4)
})
```

Drop the `min_lat_unused` key when writing the test; it is here only so the row literal is copied whole from `ogrinfo` output and then trimmed. `test/unit/schema.test.ts` accepts the Tycho feature and an Olympus Mons feature (`body: "mars"`), refuses `body: "venus"`, a latitude of 91, a longitude of 181, and a missing `id`. `test/unit/bodies.test.ts` asserts `BODIES.moon.metresPerDegree` is within 1 of 30,323 and `BODIES.mars.metresPerDegree` within 1 of 59,159, and that both `coordinates.longitudeRange` read `"0..360"`.

- [ ] **Step 2: Run to see them fail, then write the modules**

`lib/bodies.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The bodies this pipeline builds, with the conventions their USGS products use. A body is explicit in every record
 *   and artifact; nothing here treats Earth as the reference.
 */

import { BODY_RADII_KM, type PlanetaryBodyID } from "@mailwoman/spatial"

export type { PlanetaryBodyID }

export interface PlanetaryCoordinateMetadata {
	longitudeDirection: "east" | "west"
	longitudeRange: "-180..180" | "0..360"
	latitudeType: "planetocentric" | "planetographic"
	referenceBody: string
	controlNetwork?: string
}

export interface PlanetaryBody {
	id: Exclude<PlanetaryBodyID, "earth">
	name: string
	iauTargetName: string
	meanRadiusKm: number
	shape: "sphere" | "ellipsoid"
	/**
	 * Metres per degree of arc on the mean sphere: 2πR / 360. The hillshade's vertical scale, and the only place a
	 * degree becomes a length in this package.
	 */
	metresPerDegree: number
	coordinates: PlanetaryCoordinateMetadata
}

const metresPerDegree = (radiusKm: number): number => (2 * Math.PI * radiusKm * 1000) / 360

export const BODIES = {
	moon: {
		id: "moon",
		name: "Moon",
		iauTargetName: "Moon",
		meanRadiusKm: BODY_RADII_KM.moon,
		shape: "sphere",
		metresPerDegree: metresPerDegree(BODY_RADII_KM.moon),
		coordinates: {
			longitudeDirection: "east",
			longitudeRange: "0..360",
			latitudeType: "planetocentric",
			referenceBody: "Moon_2000_IAU_IAG (sphere, 1737400 m)",
			controlNetwork: "LOLA 2011",
		},
	},
	mars: {
		id: "mars",
		name: "Mars",
		iauTargetName: "Mars",
		meanRadiusKm: BODY_RADII_KM.mars,
		shape: "ellipsoid",
		metresPerDegree: metresPerDegree(BODY_RADII_KM.mars),
		coordinates: {
			longitudeDirection: "east",
			longitudeRange: "0..360",
			latitudeType: "planetocentric",
			referenceBody: "Mars_2000_IAU_IAG (ellipsoid, 3396190 m, 1/f 169.894)",
			controlNetwork: "MDIM 2.1",
		},
	},
} as const satisfies Record<"moon" | "mars", PlanetaryBody>

export type BuildableBodyID = keyof typeof BODIES
```

`lib/schema/nomenclature.ts`:

```ts
import { blankAsAbsent } from "@mailwoman/core/env/utils"
import { z } from "zod"

export const PlanetaryNomenclatureFeatureSchema = z.object({
	id: z.string().min(1),
	body: z.enum(["moon", "mars"]),
	name: z.string().min(1),
	// The shapefile writes "" for an absent string; `blankAsAbsent` (the env schema helper, the one home for that
	// mapping) turns it into absence before the optional applies.
	cleanName: blankAsAbsent(z.string()),
	featureType: z.string().min(1),
	featureTypeCode: blankAsAbsent(z.string()),
	diameterKm: z.number().nonnegative().optional(),
	centerLon: z.number().min(-180).max(180),
	centerLat: z.number().min(-90).max(90),
	bbox: z
		.object({
			minLon: z.number().min(-180).max(180),
			maxLon: z.number().min(-180).max(180),
			minLat: z.number().min(-90).max(90),
			maxLat: z.number().min(-90).max(90),
			crossesAntimeridian: z.boolean(),
		})
		.optional(),
	approvalStatus: blankAsAbsent(z.string()),
	approvalDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/u)
		.optional(),
	origin: blankAsAbsent(z.string()),
	quadName: blankAsAbsent(z.string()),
	source: z.literal("usgs-iau"),
})

export type PlanetaryNomenclatureFeature = z.infer<typeof PlanetaryNomenclatureFeatureSchema>
```

`lib/normalize.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Source row → feature, once, at build. The USGS products use east longitude in 0..360 with bounding boxes that may
 *   run past 360 (a feature on the prime meridian reads 359.2..360.16); rendering wants −180..180. Every conversion is
 *   here so a consumer never guesses the source convention.
 */

import type { BuildableBodyID } from "#bodies"
import { type PlanetaryNomenclatureFeature, PlanetaryNomenclatureFeatureSchema } from "#schema/nomenclature"

export interface NomenclatureSourceRow {
	name: string
	clean_name: string
	approvaldt: string
	origin: string
	diameter: number | null
	center_lon: number
	center_lat: number
	type: string
	code: string
	approval: string
	min_lon: number
	max_lon: number
	min_lat: number
	max_lat: number
	quad_name: string
	link: string
}

export interface NormalizedBBox {
	minLon: number
	maxLon: number
	minLat: number
	maxLat: number
	/**
	 * True when the box's west edge is east of its east edge after normalization: the box runs across ±180 and a
	 * renderer must split it, never draw it as a near-global rectangle.
	 */
	crossesAntimeridian: boolean
}

export function normalizeLongitude(lon: number): number {
	if (!Number.isFinite(lon) || lon < -180 || lon > 360)
		throw new RangeError(`longitude ${lon} is outside 0..360 and -180..180`)

	const shifted = lon > 180 ? lon - 360 : lon

	return Object.is(shifted, -0) ? 0 : shifted
}

const clampLat = (lat: number): number => Math.max(-90, Math.min(90, lat))

export function normalizeBBox(box: { minLon: number; maxLon: number; minLat: number; maxLat: number }): NormalizedBBox {
	// A box that runs past 360 wraps to the prime meridian; a box that runs past 180 wraps to the antimeridian. Both
	// arrive as minLon < maxLon in source units; only the second one crosses ±180 after normalization.
	const minLon = normalizeLongitude(box.minLon > 360 ? box.minLon - 360 : box.minLon)
	const maxLon = normalizeLongitude(box.maxLon > 360 ? box.maxLon - 360 : box.maxLon)

	return {
		minLon,
		maxLon,
		minLat: clampLat(box.minLat),
		maxLat: clampLat(box.maxLat),
		crossesAntimeridian: minLon > maxLon,
	}
}

export function featureIDFromLink(link: string): string {
	const match = /\/Feature\/(\d+)\s*$/u.exec(link)

	if (!match?.[1]) throw new Error(`nomenclature link carries no feature id: ${JSON.stringify(link)}`)

	return match[1]
}

export function approvalDateFromSource(value: string): string | undefined {
	const match = /^(\d{4})\/(\d{2})\/(\d{2})/u.exec(value)

	return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined
}

export function featureFromSourceRow(body: BuildableBodyID, row: NomenclatureSourceRow): PlanetaryNomenclatureFeature {
	return PlanetaryNomenclatureFeatureSchema.parse({
		id: featureIDFromLink(row.link),
		body,
		name: row.name,
		cleanName: row.clean_name,
		featureType: row.type,
		featureTypeCode: row.code,
		diameterKm: row.diameter ?? undefined,
		centerLon: normalizeLongitude(row.center_lon),
		centerLat: clampLat(row.center_lat),
		bbox: normalizeBBox({ minLon: row.min_lon, maxLon: row.max_lon, minLat: row.min_lat, maxLat: row.max_lat }),
		approvalStatus: row.approval,
		approvalDate: approvalDateFromSource(row.approvaldt),
		origin: row.origin,
		quadName: row.quad_name,
		source: "usgs-iau",
	})
}
```

The Marco Polo P test expects `minLon` −0.8023 from 359.1977 and `maxLon` 0.1643 from 360.1643; check `normalizeBBox` against it before moving on. `diameter ?? undefined` converts the shapefile's null to absence, which is what the schema's optional means; a zero diameter stays zero. Read `blankAsAbsent` in `packages/core/lib/env/utils.ts` before relying on it: it must map `""` to `undefined` and leave a non-blank string alone; if it also trims, the test rows above still pass.

- [ ] **Step 3: Run, lint, commit**

```bash
yarn compile
yarn vitest --run --config vitest.fast.config.ts packages/astrogeology/test/unit
yarn oxlint packages/astrogeology
git add packages/astrogeology
git commit -m "feat(astrogeology): bodies, the nomenclature feature schema, and normalization with the three measured rows as tests"
```

---

### Task 3: Sources, the lock, and the fetchers

**Files:**

- Create: `lib/sdk/sources.ts`, `lib/sdk/fetch.ts`, `lib/schema/manifest.ts`, `sources.lock.json`
- Test: `test/unit/schema.test.ts` (the lock and manifest schemas)

**Interfaces:**

- Produces: `SOURCES` (the table above as typed records `{ id, body, kind: "nomenclature" | "dem", url, expectedBytes, pinned: "snapshot" | "product" }`); `SourcesLockSchema` (`{ [sourceID]: { url, bytes, sha256, fetchedAt, snapshot?: "YYYY-MM-DD" } }`); `readLock()`, `writeLock()`; `downloadPinned(source, options: { snapshotDate?: string }): Promise<{ path, bytes, sha256, reused: boolean }>`; `PlanetaryBuildManifestSchema`.

- [ ] **Step 1: Look for a streaming download home before writing one**

```bash
grep -n "fetch(\|pipeline(\|movePath\|tmp" packages/core/lib/utils/geodatabase-archive.ts packages/tiger/lib/sdk/download.ts packages/osm/lib/sdk/fetch.ts | head -20
```

Three fetchers stream a response to a `.tmp` sibling and rename. If `packages/core/lib/utils/geodatabase-archive.ts` already exposes that half as a function taking `(url, dest)`, import it; if all three inline it, extract `downloadToFile(url, dest, { onProgress? })` into `packages/core/lib/fs/download.ts` (exported as `@mailwoman/core/fs/download`, the one module allowed to hold the stream-to-disk shape, using `openWriteStream` from `#fs/streams` and `movePath` from `#fs/writers`), make the three fetchers call it, and add a `HELPER_HOMES` row for the `Readable.fromWeb(res.body)` shape. The tiger fetcher keeps its zip-integrity check around the call; that is its own contract.

- [ ] **Step 2: The source table and the lock**

`lib/sdk/sources.ts` carries the four rows of the measured table as `SOURCES`, each with `url`, `expectedBytes` (the DEM byte counts; `null` for the nightly archives), `pinned: "snapshot"` for nomenclature and `"product"` for the DEMs, and `license: "public-domain"`. `lib/schema/manifest.ts` carries `SourcesLockSchema` and `PlanetaryBuildManifestSchema`:

```ts
export const PlanetaryBuildManifestSchema = z.object({
	schemaVersion: z.literal(1),
	body: z.enum(["moon", "mars"]),
	builtAt: z.string().datetime(),
	sources: z.array(
		z.object({
			id: z.string(),
			url: z.string().url(),
			sha256: z.string().length(64),
			bytes: z.number().int().positive(),
			snapshot: z.string().optional(),
			coordinates: z
				.object({
					longitudeDirection: z.enum(["east", "west"]),
					longitudeRange: z.enum(["-180..180", "0..360"]),
					latitudeType: z.enum(["planetocentric", "planetographic"]),
					referenceBody: z.string(),
					controlNetwork: z.string().optional(),
				})
				.optional(),
		})
	),
	outputs: z.array(
		z.object({
			tileset: z.string(),
			path: z.string(),
			sha256: z.string().length(64),
			bytes: z.number().int().positive(),
		})
	),
	transformations: z.array(z.string()),
})
```

`transformations` is the list of exact tool invocations the build ran (Task 5 and 6 append theirs), which is the "record the exact transformation" the spec asks for.

- [ ] **Step 3: `downloadPinned`**

```ts
export async function downloadPinned(
	source: PlanetarySource,
	options: { snapshotDate?: string } = {}
): Promise<FetchedSource> {
	const lock = await readLock()
	const snapshot = source.pinned === "snapshot" ? (options.snapshotDate ?? isoDate()) : undefined
	const dest = dataRootPath(
		"astrogeology",
		source.body,
		"source",
		snapshot ? `${source.id}-${snapshot}${extname(source.url)}` : basename(source.url)
	)
	const locked = lock[source.id]

	if (locked && (await pathExists(dest))) {
		const bytes = (await statPath(dest)).size
		if (bytes !== locked.bytes)
			throw new Error(
				`${source.id}: cached ${bytes} bytes, lock says ${locked.bytes} — the cache is not the pinned file`
			)
		return { path: String(dest), bytes, sha256: locked.sha256, reused: true }
	}

	await downloadToFile(source.url, dest)
	const bytes = (await statPath(dest)).size
	if (source.expectedBytes !== null && bytes !== source.expectedBytes)
		throw new Error(
			`${source.id}: ${bytes} bytes downloaded, ${source.expectedBytes} expected — the product changed under its URL`
		)
	const sha256 = await sha256File(String(dest))
	if (locked && locked.sha256 !== sha256)
		throw new Error(
			`${source.id}: sha256 ${sha256} differs from the lock's ${locked.sha256} — review the source before re-pinning`
		)

	await writeLock({
		...lock,
		[source.id]: { url: source.url, bytes, sha256, fetchedAt: isoSeconds(), ...(snapshot ? { snapshot } : {}) },
	})

	return { path: String(dest), bytes, sha256, reused: false }
}
```

`isoDate` and `isoSeconds` from `@mailwoman/core/utils`, `sha256File` from `@mailwoman/core/hash`, `pathExists`/`statPath` from `@mailwoman/core/fs/readers`, `basename`/`extname` from `path-ts`. The lock lives at `packages/astrogeology/sources.lock.json` (`resolvePackagePath("@mailwoman/astrogeology", "sources.lock.json")`) and is committed; `fetch` is the only writer.

- [ ] **Step 4: Fetch the two nomenclature snapshots for real, commit the lock**

```bash
yarn compile
node packages/astrogeology/out/cli.js fetch --body moon --kind nomenclature
node packages/astrogeology/out/cli.js fetch --body mars --kind nomenclature
cat packages/astrogeology/sources.lock.json
```

Expected: two entries with today's snapshot date, byte counts near 23,842,450 and 5,413,387 (a nightly archive moves by a few kilobytes), and 64-character hashes. The DEMs are fetched in Task 6 (8.5 GB and 2.1 GB; run on the lab, not in CI). The `fetch` command is written in Task 7; for this step, a three-line `node -e` over `downloadPinned` is acceptable if the command does not exist yet, but the lock content is what gets committed.

```bash
git add packages/astrogeology
git commit -m "feat(astrogeology): pinned sources, the lock, and the streaming fetch; nomenclature snapshots locked"
```

---

### Task 4: The nomenclature build

**Files:**

- Create: `lib/build/nomenclature.ts`, `lib/build/metadata.ts`, `lib/schema/pmtiles-metadata.ts`
- Test: `test/integration/fixture-build.test.ts` (the nomenclature half), `test/unit/schema.test.ts` (metadata block)

**Interfaces:**

- Produces: `readNomenclatureRows(archivePath): AsyncIterable<NomenclatureSourceRow>` (ogr2ogr to GeoJSONSeq, parsed row by row); `writeNomenclatureNDJSON(features, outPath)` with tippecanoe hints; `buildNomenclaturePMTiles({ body, ndjsonPath, outPath }): Promise<{ command: string[] }>`; `PMTilesMetadataSchema`; `applyPMTilesMetadata(archivePath, block)`.

- [ ] **Step 1: Rows from the archive**

`ogr2ogr` reads the shapefile straight out of the zip and writes newline-delimited GeoJSON, which `JSONSpliterator` consumes without loading 23 MB of attributes at once:

```ts
export async function* readNomenclatureRows(archivePath: string, layer: string): AsyncIterable<NomenclatureSourceRow> {
	await using scratch = await temporaryDirectory("astrogeology-")
	const seq = resolvePath(scratch.path, `${layer}.geojsonl`)

	await runFile("ogr2ogr", ["-f", "GeoJSONSeq", String(seq), `/vsizip/${archivePath}`, layer])

	for await (const feature of JSONSpliterator.fromAsync<{ properties: NomenclatureSourceRow }>(seq)) {
		yield feature.properties
	}
}
```

The layer names are `MOON_nomenclature_center_pts` and `MARS_nomenclature_center_pts`; put them on the source records. Read `temporaryDirectory`'s interface in `packages/core/lib/fs/temporary.ts` for the field that carries the path.

- [ ] **Step 2: NDJSON with declutter hints, then tippecanoe**

The declutter rule the spec asks for, as tippecanoe per-feature `minzoom`: a feature's minimum zoom is a function of its diameter, so a large crater appears at a low zoom and a small one later. One function, tested:

```ts
/**
 * The zoom at which a feature first appears, from its diameter in kilometres: ≥300 km at 0, ≥100 at 2, ≥30 at 4,
 * ≥10 at 6, everything else at 8. Cartographic decluttering, not ranking; a feature with no diameter (a region, a
 * landing site) appears at 2.
 */
export function minZoomForDiameter(diameterKm: number | undefined): number {
	if (diameterKm === undefined) return 2
	if (diameterKm >= 300) return 0
	if (diameterKm >= 100) return 2
	if (diameterKm >= 30) return 4
	if (diameterKm >= 10) return 6

	return 8
}
```

Each NDJSON line is a GeoJSON point feature with `tippecanoe: { layer: "nomenclature", minzoom }` and the feature's properties. `buildNomenclaturePMTiles` runs, through `runFile("tippecanoe", args)`:

```ts
const args = [
	"-o",
	outPath,
	"-l",
	"nomenclature",
	"-n",
	`Mailwoman ${BODIES[body].name} nomenclature`,
	"-A",
	"USGS Astrogeology / IAU Working Group for Planetary System Nomenclature (public domain)",
	"--minimum-zoom",
	"0",
	"--maximum-zoom",
	"8",
	"-r1",
	"--no-feature-limit",
	"--no-tile-size-limit",
	"--no-progress-indicator",
	"--force",
	ndjsonPath,
]
```

`-r1` turns off tippecanoe's point dropping, which would otherwise thin the layer by density; the per-feature `minzoom` is the only declutter. `packages/mailwoman/lib/coverage/core.ts` runs tippecanoe through `zx`; this package runs it through `runFile`, and the argument list is its own (a different layer, different flags), so there is no shared shape to extract.

- [ ] **Step 3: Metadata**

`lib/schema/pmtiles-metadata.ts`:

```ts
export const PMTilesMetadataSchema = z.object({
	"mailwoman:kind": z.enum(["planetary-basemap", "planetary-hillshade", "planetary-dem"]),
	"mailwoman:body": z.enum(["moon", "mars"]),
	"mailwoman:schema": z.literal("planetary-v1"),
	"mailwoman:coordinate_longitude": z.literal("east-positive--180-180"),
	"mailwoman:coordinate_latitude": z.enum(["planetocentric", "planetographic"]),
	"mailwoman:source": z.string().min(1),
	"mailwoman:build_version": z.string().min(1),
	"mailwoman:vertical_datum": z.string().optional(),
	"mailwoman:elevation_unit": z.literal("metre").optional(),
	"mailwoman:source_product": z.string().optional(),
})
```

`applyPMTilesMetadata(archivePath, block)` validates the block, reads the archive's current metadata (`pmtiles show <archive> --metadata`), merges the keys over it, writes the merged JSON to a scratch file and runs `pmtiles edit <archive> --metadata <file>`. Confirm the flag name first with `pmtiles edit --help`; the lab's binary lists `edit <input>` under "Edit JSON metadata or parts of the header". Then read it back with `pmtiles show <archive> --metadata` and assert the block round-trips; that read-back is the verify step's check.

- [ ] **Step 4: The fixture and the integration test**

`test/fixtures/moon-nomenclature.ndjson` holds five source rows in the `NomenclatureSourceRow` shape: Marco Polo P (the 360 wrap), Tycho, a polar feature (any row with `center_lat` below −89 from the archive: `ogrinfo -q -where "center_lat < -89" /vsizip/moon.zip | head`), one with `center_lon` between 179 and 181, and one with an empty `diameter`. `test/fixtures/mars-nomenclature.ndjson` holds Olympus Mons and two more. `test/integration/fixture-build.test.ts`:

```ts
test("the Moon fixture builds a nomenclature archive whose tiles carry the five features", async () => {
	await using scratch = await temporaryDirectory("astrogeology-test-")
	const ndjson = resolvePath(scratch.path, "moon.ndjson")
	const out = resolvePath(scratch.path, "moon.pmtiles")
	const rows = await Array.fromAsync(
		JSONSpliterator.fromAsync<NomenclatureSourceRow>(fixturePath("moon-nomenclature.ndjson"))
	)
	const features = rows.map((row) => featureFromSourceRow("moon", row))

	await writeNomenclatureNDJSON(features, String(ndjson))
	await buildNomenclaturePMTiles({ body: "moon", ndjsonPath: String(ndjson), outPath: String(out) })
	await applyPMTilesMetadata(String(out), nomenclatureMetadata("moon", "test"))

	const metadata = JSON.parse((await runFile("pmtiles", ["show", String(out), "--metadata"])).stdout) as Record<
		string,
		unknown
	>
	expect(metadata["mailwoman:body"]).toBe("moon")
	expect(metadata["mailwoman:schema"]).toBe("planetary-v1")

	// Tycho at z4: the tile that contains lon -11.2, lat -43.3 (x=7, y=9 at z4 in the XYZ scheme).
	const tile = await runFile("pmtiles", ["tile", String(out), "4", "7", "9"], { encoding: "buffer" })
	expect(tile.stdout.length).toBeGreaterThan(0)
})
```

Compute the z4 tile for Tycho with the standard XYZ formula before pinning `7, 9`: `x = floor((lon + 180) / 360 · 16)`, `y = floor((1 − ln(tan(lat) + sec(lat)) / π) / 2 · 16)` with `lat` in radians; write the two numbers you get. A missing `tippecanoe` or `pmtiles` makes `runFile` throw `ENOENT` naming the tool, which is the failure the spec wants.

- [ ] **Step 5: Run and commit**

```bash
yarn compile
yarn vitest --run --config vitest.slow.config.ts packages/astrogeology/test/integration
git add packages/astrogeology
git commit -m "feat(astrogeology): nomenclature build — rows through ogr2ogr, declutter by diameter, tippecanoe, the metadata block"
```

---

### Task 5: The hillshade build

**Files:**

- Create: `lib/build/hillshade.ts`
- Test: `test/integration/fixture-build.test.ts` (the hillshade half); `test/fixtures/dem-64.tif`

**Interfaces:**

- Produces: `buildHillshadePMTiles({ body, demPath, outPath, maxZoom }): Promise<{ commands: string[][] }>`.

- [ ] **Step 1: The chain, as four `runFile` calls**

```ts
export async function buildHillshadePMTiles(options: {
	body: BuildableBodyID
	demPath: string
	outPath: string
	maxZoom: number
}): Promise<{ commands: string[][] }> {
	const body = BODIES[options.body]
	await using scratch = await temporaryDirectory("astrogeology-hillshade-")
	const shaded = resolvePath(scratch.path, "hillshade.tif")
	const forTiling = resolvePath(scratch.path, "hillshade-4326.tif")
	const mbtiles = resolvePath(scratch.path, "hillshade.mbtiles")

	// 1. Shade in the source grid, where a degree is the body's arc length; `-s` is metres per degree on this body.
	const shade = [
		"hillshade",
		options.demPath,
		String(shaded),
		"-s",
		String(body.metresPerDegree),
		"-z",
		"1",
		"-az",
		"315",
		"-alt",
		"45",
		"-compute_edges",
		"-co",
		"COMPRESS=DEFLATE",
	]
	await runFile("gdaldem", shade)

	// 2. The XYZ tile scheme is angular: the same lon/lat grid on any sphere. Declaring the shaded image as EPSG:4326
	//    makes GDAL tile it on that grid; the metres are Earth's, which is why shading happened before this step.
	const declare = ["-a_srs", "EPSG:4326", String(shaded), String(forTiling)]
	await runFile("gdal_translate", declare)

	// 3. MBTiles with PNG tiles and overviews down to zoom 0, then PMTiles.
	const tile = [
		"-of",
		"MBTILES",
		"-co",
		"TILE_FORMAT=PNG",
		"-co",
		`ZOOM_LEVEL_STRATEGY=LOWER`,
		"-co",
		`MAXZOOM=${options.maxZoom}`,
		String(forTiling),
		String(mbtiles),
	]
	await runFile("gdal_translate", tile)
	const overviews = [
		String(mbtiles),
		...Array.from({ length: options.maxZoom }, (_, index) => String(2 ** (index + 1))),
	]
	await runFile("gdaladdo", ["-r", "average", ...overviews])
	await runFile("pmtiles", ["convert", String(mbtiles), options.outPath])

	return {
		commands: [
			["gdaldem", ...shade],
			["gdal_translate", ...declare],
			["gdal_translate", ...tile],
			["gdaladdo", ...overviews],
			["pmtiles", "convert", String(mbtiles), options.outPath],
		],
	}
}
```

`gdal_translate -of MBTILES` needs the input in a geographic or Web Mercator CRS and does the Mercator warp itself; read `gdal_translate --formats | grep -i mbtiles` and `gdal_translate --format MBTILES` for the exact creation options this GDAL build supports (`TILE_FORMAT`, `ZOOM_LEVEL_STRATEGY`, `MAXZOOM` are the documented names) and adjust before the first run. The `commands` array is appended to the manifest's `transformations`.

- [ ] **Step 2: The fixture DEM and its test**

Generate the fixture once and commit it:

```bash
gdal_create -of GTiff -outsize 64 64 -bands 1 -ot Int16 -a_srs EPSG:4326 -a_ullr -180 90 180 -90 -burn 0 packages/astrogeology/test/fixtures/dem-64.tif
python3 -c "
import numpy, sys
" 2>/dev/null || true
```

`gdal_create` writes a flat raster; a flat DEM shades to a uniform image, which proves the chain runs but not that shading sees relief. Add relief with a second command that GDAL provides: `gdal_calc.py -A dem-64.tif --outfile=dem-64.tif --calc="(A*0)+ (numpy.indices((64,64))[0]*40)" --overwrite` gives a north–south ramp of 40 m per row. If `gdal_calc.py` is not on the lab, write the ramp with `gdal_translate -scale` over a gradient PNG, or with `@mailwoman/core`'s own GeoTIFF writer if one exists (`grep -rln "GeoTIFF\|geotiff" packages/core/lib`); the point is a small committed raster with a gradient, and the command that made it goes in the test file's header.

The test builds `dem-64.tif` to `hillshade.pmtiles` with `maxZoom: 2`, asserts the archive exists, that `pmtiles tile out.pmtiles 0 0 0` returns a PNG (the first eight bytes are `89 50 4E 47 0D 0A 1A 0A`), and that the tile at z1 differs from a uniform image (at least two distinct byte values in the decoded PNG is enough; decode with `sharp`, which is in the workspace, or compare two tiles' bytes for inequality).

- [ ] **Step 3: Run and commit**

```bash
yarn compile
yarn vitest --run --config vitest.slow.config.ts packages/astrogeology/test/integration
git add packages/astrogeology
git commit -m "feat(astrogeology): hillshade build — gdaldem in the body's metres, XYZ tiling by the angular grid, PMTiles"
```

---

### Task 6: The search artifact and the manifest

**Files:**

- Create: `lib/build/search-index.ts`, `lib/build/manifest.ts`
- Test: `test/integration/fixture-build.test.ts` (both)

**Interfaces:**

- Produces: `buildSearchIndex(features, outPath): Promise<void>` writing an ancestrie artifact whose entries are feature names and aliases with the feature id as payload; `emitManifest({ body, sources, outputs, transformations }, outPath)`.

- [ ] **Step 1: Read the ancestrie builder's contract, then write the index**

```bash
sed -n 1,80p packages/ancestrie/README.md
grep -n "export interface AncestrieEntry\|export interface AncestrieBuilderOptions\|export type AncestrieEntry" -A12 packages/ancestrie/lib/*.ts | head -40
```

The builder takes entries with a path of tokens, a rank and a payload, and the reader answers `autocomplete(trie, tokens)`. `buildSearchIndex` adds one entry per feature for `name`, one per alias when `cleanName` differs from `name`, ranks by `diameterKm ?? 0` so a larger feature sorts first at equal prefix, and stores `{ id, body, featureType, centerLon, centerLat }` as the payload; it then writes the builder's bytes with `writeLocalFile`. Tokens are the lowercased words of the name; the reader's own tokenizer, if it exports one, is the one to use so the app tokenizes the query the same way (`grep -n "export function tokenize" packages/ancestrie/lib/*.ts`).

- [ ] **Step 2: The manifest**

`emitManifest` builds the object, validates it with `PlanetaryBuildManifestSchema`, computes each output's `sha256File` and size, and writes `manifest.json` beside the outputs.

- [ ] **Step 3: Extend the integration test**

After the nomenclature build: `buildSearchIndex(features, index)`, then `Ancestrie.from(await readLocalBuffer(index))` and `autocomplete(reader, ["tych"])` returns Tycho's id first. After both builds: `emitManifest` writes a file that `PlanetaryBuildManifestSchema.parse` accepts, with two outputs and two sources. Commit:

```bash
git add packages/astrogeology
git commit -m "feat(astrogeology): the search artifact over feature names, and the build manifest with checksums"
```

---

### Task 7: The bin, and `publishTiles` as a function in `mailwoman`

**Files:**

- Create: `lib/cli.ts`, `lib/commands/fetch.tsx`, `lib/commands/build.tsx`, `lib/commands/verify.tsx`, `lib/commands/publish.tsx`
- Create: `packages/mailwoman/lib/tiles/publish.ts` (moved from `lib/commands/tiles/publish.tsx`'s `publishTiles`); Modify: that command file to import it; `packages/mailwoman/package.json` (`exports["./tiles/publish"]`)

**Interfaces:**

- Consumes: `CommandSpec`, `ParsedCommandComponent`, `useCommandTask`, `CommandTaskResult` from `mailwoman/cli-kit`; `runDropInCLI` is for drop-in servers and is not used here.
- Produces: `astrogeology fetch --body <moon|mars> [--kind nomenclature|dem]`, `astrogeology build --body <moon|mars> [--max-zoom 6] [--out <dir>]`, `astrogeology verify --body <moon|mars>`, `astrogeology publish --body <moon|mars> [--dry-run]`; `publishTiles(options): Promise<string>` from `mailwoman/tiles/publish`.

- [ ] **Step 1: Read the two CLIs this one copies from**

```bash
sed -n 1,80p packages/mailwoman/lib/commands/tiles/publish.tsx
sed -n 40,120p packages/libpostal/lib/cli.ts
grep -n "^export" packages/mailwoman/lib/cli-kit/index.ts | cut -c1-120
```

`packages/libpostal/lib/cli.ts` is a package with its own `bin` over `mailwoman/cli-kit`; `tiles/publish.tsx` is the command shape (`spec` with `options`, a `ParsedCommandComponent` rendering `CommandTaskResult` over `useCommandTask`). The astrogeology `cli.ts` selects one of four command modules by the first positional through `parseArguments` from `@mailwoman/core/scripting/arguments` and renders it with Ink the way `libpostal`'s does; if cli-kit exports a runner that takes a command table (`grep -n "runCommand\|selectCommand" packages/mailwoman/lib/cli-kit/*.ts`), use it rather than writing the dispatch.

- [ ] **Step 2: Move `publishTiles`**

Move the `publishTiles` function and its `Options` type from `packages/mailwoman/lib/commands/tiles/publish.tsx` into `packages/mailwoman/lib/tiles/publish.ts` (exported), import it back into the command, add `"./tiles/publish"` to `mailwoman`'s `exports`. The command's `spec` stays where it is. The astrogeology `publish` command calls `publishTiles({ file, tileset: body, bucket: "nexus-assets", prefix: "tiles", dryRun })` twice (the vector and the hillshade archive), then fetches `https://tiles.mailwoman.ai/<body>.json` and the z0 tile of each and reports the status codes.

- [ ] **Step 3: The four commands**

`build --body moon` runs, in order: `downloadPinned` for the locked nomenclature snapshot and the DEM (refusing if the lock lacks either: "run `astrogeology fetch` first"), `readNomenclatureRows` → `featureFromSourceRow` → `writeNomenclatureNDJSON` → `buildNomenclaturePMTiles` → `applyPMTilesMetadata`, `buildHillshadePMTiles` → `applyPMTilesMetadata`, `buildSearchIndex`, `emitManifest`, all under `dataRootPath("astrogeology", body, "build")`. `verify --body moon` re-reads the manifest, recomputes each output's SHA-256 and compares, reads each archive's metadata back and validates the block, and refuses on any difference. Progress goes through `useCommandTask`'s reporting, as `tiles publish` does.

- [ ] **Step 4: Build the Moon for real, then Mars**

```bash
yarn compile
node packages/astrogeology/out/cli.js fetch --body moon --kind dem     # 8.5 GB; run on the lab, once
node packages/astrogeology/out/cli.js build --body moon --max-zoom 6
node packages/astrogeology/out/cli.js verify --body moon
ls -la "$MAILWOMAN_DATA_ROOT/astrogeology/moon/build"
```

Expected: `moon.pmtiles` (a few MB), `moon-hillshade.pmtiles` (zoom 6 over the whole body is 4,096 tiles at z6 plus overviews, tens of MB), `moon-search.ancestrie`, `manifest.json`; `verify` passes. Then the same three commands for `mars`. Record the four sizes and the wall-clock of each build in the commit message; those numbers decide the max zoom for the first publish.

- [ ] **Step 5: Commit**

```bash
git add packages/astrogeology packages/mailwoman
git commit -m "feat(astrogeology): the bin — fetch, build, verify, publish; publishTiles is a mailwoman function"
```

---

### Task 8: Publish, README, preflight, PR

- [ ] **Step 1: Publish both bodies**

```bash
node packages/astrogeology/out/cli.js publish --body moon --dry-run
node packages/astrogeology/out/cli.js publish --body moon
node packages/astrogeology/out/cli.js publish --body mars
curl -sI https://tiles.mailwoman.ai/moon.json | head -1
curl -sI https://tiles.mailwoman.ai/moon-hillshade/0/0/0.png | head -1
curl -s https://tiles.mailwoman.ai/mars.json | head -c 300
```

Expected: `200` for the TileJSON and the z0 hillshade tile, and the Mars TileJSON naming the `nomenclature` layer. The R2 credentials are the ones `mailwoman tiles publish` already reads from the private environment.

- [ ] **Step 2: README**

`packages/astrogeology/README.md` carries the source table, the pin policy (snapshot for the nightly gazetteer, product for the DEMs), the four commands, the data-root layout, the tool prerequisites (GDAL 3.x with the MBTiles driver, tippecanoe, pmtiles), and the attribution lines the app renders.

- [ ] **Step 3: Preflight and PR**

```bash
yarn compile && yarn health > /tmp/health.log 2>&1; echo "EXIT=$?" >> /tmp/health.log; grep -n "✗\|error:\|EXIT=" /tmp/health.log | head
yarn typecheck:tests
yarn ci:test:fast
yarn vitest --run --config vitest.slow.config.ts packages/astrogeology packages/spatial
git push -u origin feat/astrogeology
gh pr create --title "Astrogeology: the Moon and Mars nomenclature and hillshade pipeline" --body-file - <<'EOF'
Implements docs/superpowers/specs/2026-09-06-astrogeology-pipeline-design.md by docs/superpowers/plans/2026-09-07-astrogeology-pipeline.md.

- packages/astrogeology (private): pinned USGS sources (nightly gazetteer by snapshot, DEMs by product), normalization measured against the real rows (0..360 → −180..180, the 360 wrap, ids from the link column), tippecanoe nomenclature archives decluttered by diameter, gdaldem hillshade in the body's metres and XYZ tiling by the angular grid, an ancestrie search artifact, a manifest with checksums, the mailwoman:* metadata block validated on write and read
- @mailwoman/spatial: greatCircleDistance with a body radius; haversine unchanged
- mailwoman/tiles/publish: publishTiles as a function the command and this pipeline both call

Published: moon.pmtiles, moon-hillshade.pmtiles, mars.pmtiles, mars-hillshade.pmtiles at tiles.mailwoman.ai (sizes and build times in the build commit).

https://claude.ai/code/session_01ADYjzV88cHb94MRW4Dn1Aq
EOF
```
