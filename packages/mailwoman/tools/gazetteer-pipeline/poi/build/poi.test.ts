/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildPOIDatabase} — the load/materialize/seal phase of `poi.db` — fed a synthetic `Iterable<POISourceRow>` so the suite runs without DuckDB or network.
 */

import { isFile, statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { LayerTier, readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import { CoverageBasis } from "@mailwoman/evidence"
import type { POISourceRow } from "@mailwoman/osm/sdk/extract/poi"
import { POILookup } from "@mailwoman/resolver-wof-sqlite/poi"
import type { POICategoryCodeTable, POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi"
import { shortCellToInt, type H3Cell, type LatLonBounds } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToParent, latLngToCell } from "h3-js"
import type { PathBuilder } from "path-ts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { bboxCoverageCells, buildPOIDatabase } from "#gazetteer/poi/build/poi"

const SPRINGFIELD = { latitude: 39.7817, longitude: -89.6501, country: "US" as const }
const PARIS = { latitude: 48.8566, longitude: 2.3522, country: "FR" as const }
const CATEGORIES = ["cafe", "restaurant", "museum"] as const
/**
 * ~3m lat steps, well under a res-9 hex's ~174m edge, so a (country, category) group clusters into one cell.
 */
const JITTER_DEG = 0.00003

function* fixtureRows(): Iterable<POISourceRow> {
	let gersCounter = 0

	for (const loc of [SPRINGFIELD, PARIS]) {
		for (const category of CATEGORIES) {
			for (let n = 0; n < 5; n++) {
				gersCounter++

				yield {
					name: `${loc.country} ${category} #${n}`,
					category,
					brandWikidata: n === 0 ? "Q00000" : null,
					latitude: loc.latitude + n * JITTER_DEG,
					longitude: loc.longitude,
					country: loc.country,
					confidence: 0.85 + n * 0.03,
					gersID: `gers-${gersCounter}`,
				}
			}
		}
	}

	// Non-finite coordinates — the loader must skip + count these, never insert garbage.
	yield {
		name: "Bad NaN",
		category: "cafe",
		brandWikidata: null,
		latitude: Number.NaN,
		longitude: -89,
		country: "US",
		confidence: 0.9,
		gersID: "bad-nan",
	}

	yield {
		name: "Bad Infinity",
		category: "cafe",
		brandWikidata: null,
		latitude: 39,
		longitude: Number.POSITIVE_INFINITY,
		country: "US",
		confidence: 0.9,
		gersID: "bad-inf",
	}
}

let scratch: TemporaryDirectory
let out: PathBuilder

beforeEach(async () => {
	scratch = await temporaryDirectory("poi-build-")
	out = scratch.path("poi.db")
})

afterEach(() => scratch[Symbol.asyncDispose]())

describe("buildPOIDatabase", () => {
	it("loads, clusters, dictionary-encodes, seals, and is end-to-end queryable via POILookup", async () => {
		const result = await buildPOIDatabase({
			rows: fixtureRows(),
			out,
			release: "2026-05-20.0",
			buildSHA: "deadbeef",
			createdAt: "2026-07-18T00:00:00Z",
		})

		expect(result.rows).toBe(30)
		expect(result.skipped).toBe(2)
		expect(result.categories).toBe(3)
		// The 2 skipped non-finite-coordinate rows are not counted, per the Map's interface.
		expect(Object.fromEntries(result.countries)).toEqual({ US: 15, FR: 15 })

		expect((await statPath(out)).mode & 0o222).toBe(0)

		// `kdb`'s dispose closes the underlying connection.
		// Another `using` on the same DatabaseSync would race it to close().
		using kdb = new DatabaseClient<POIDatabase>(out, { readOnly: true })

		// Category codes are assigned on first sight.
		// Zero remains uncategorized.
		const codes = (await kdb.selectFrom("poi_category_codes").selectAll().execute()) as POICategoryCodeTable[]
		expect(codes.map((c) => c.category).toSorted()).toEqual(["cafe", "museum", "restaurant"])
		expect(codes.every((c) => c.id > 0)).toBe(true)
		const cafeID = codes.find((c) => c.category === "cafe")!.id

		// Without a rowid, clustered disk order makes the first (h3_cell, category_id) row the best-confidence one.
		const group = await kdb
			.selectFrom("poi")
			.select(["h3_cell", "confidence"])
			.where("category_id", "=", cafeID)
			.where("country", "=", "US")
			.execute()

		expect(group).toHaveLength(5)
		const clusterCell = group[0]!.h3_cell
		expect(group.every((r) => r.h3_cell === clusterCell)).toBe(true)

		const firstPhysicalRow = await kdb
			.selectFrom("poi")
			.select(["confidence"])
			.where("h3_cell", "=", clusterCell)
			.where("category_id", "=", cafeID)
			.executeTakeFirstOrThrow()

		const maxConfidence = Math.max(...group.map((r) => r.confidence))
		expect(firstPhysicalRow.confidence).toBeCloseTo(maxConfidence, 10)

		const manifest = await readLayerManifest(kdb)

		expect(manifest).toMatchObject({
			name: "poi",
			tier: "shipped",
			license: "CDLA-Permissive-2.0",
			attribution: "Overture Maps Foundation",
			source: "overture-places",
			sourceVintage: "2026-05-20.0",
			buildCmd: "mailwoman gazetteer build poi",
			buildSHA: "deadbeef",
			freshnessPolicy: "sealed",
			spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
			createdAt: "2026-07-18T00:00:00Z",
			sourceRecords: null,
		})

		expect(result.coverageCells).toBeGreaterThan(0)
		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()
		expect(coverageRows).toHaveLength(result.coverageCells)
		expect(coverageRows.every((c) => c.observed_rows > 0 && c.completeness === 1)).toBe(true)
		const totalObserved = coverageRows.reduce((sum, c) => sum + c.observed_rows, 0)
		expect(totalObserved).toBe(30)
		// Meaning-of-zero: an unsurveyed cell is unknown, never present with completeness 0.
		expect(await readLayerCoverage(kdb, 999_999_999)).toBeNull()

		using lookup = new POILookup({ databasePath: out })
		const cafeHits = lookup.search({ categoryID: "cafe", center: SPRINGFIELD, limit: 5 })
		expect(cafeHits.length).toBeGreaterThan(0)
		expect(cafeHits.every((h) => h.name?.startsWith("US cafe"))).toBe(true)
		expect(cafeHits[0]!.confidence).toBeCloseTo(0.85, 10)

		const brandHits = lookup.search({ brandWikidata: "Q00000", center: SPRINGFIELD, limit: 10 })
		expect(brandHits.some((h) => h.brandWikidata === "Q00000")).toBe(true)

		const nameHits = lookup.search({ name: "restaurant" })
		expect(nameHits.some((h) => h.name?.includes("restaurant"))).toBe(true)
	})

	it("bootstraps missing intermediate output directories", async () => {
		const nestedOut = scratch.path("nested", "deeper", "poi.db")

		const result = await buildPOIDatabase({
			rows: fixtureRows(),
			out: nestedOut,
			release: "2026-05-20.0",
			buildSHA: "deadbeef",
			createdAt: "2026-07-18T00:00:00Z",
		})

		expect(result.rows).toBe(30)
		await expect(isFile(nestedOut)).resolves.toBe(true)
	})
})

/**
 * The pure `--source osm` helper that replaces the Overture path's "rows-present ⇒ 1" coverage.
 *
 * The bbox spans several res-6 cells so an empty or single-cluster `rows` list
 * always leaves a cell with `observedRows: 0`.
 */
describe("bboxCoverageCells", () => {
	const bbox: LatLonBounds = { minLon: -89.7, minLat: 39.7, maxLon: -89.6, maxLat: 39.85 }

	it("polyfills every res-6 cell touching the bbox, defaulting observedRows to 0", () => {
		const cells = bboxCoverageCells(bbox, [])

		expect(cells.length).toBeGreaterThan(0)
		expect(cells.every((c) => c.observedRows === 0)).toBe(true)
	})

	it("pairs each polyfilled cell with its actual observed-row count, zero permitted elsewhere in the bbox", () => {
		const rows: Array<Pick<POISourceRow, "latitude" | "longitude">> = [
			{ latitude: 39.7817, longitude: -89.6501 },
			{ latitude: 39.7817, longitude: -89.6501 },
		]

		const cells = bboxCoverageCells(bbox, rows)
		const observed = cells.filter((c) => c.observedRows > 0)

		expect(observed).toHaveLength(1)
		expect(observed[0]!.observedRows).toBe(2)
		expect(cells.some((c) => c.observedRows === 0)).toBe(true)
	})

	it("ignores rows with non-finite coordinates when aggregating observed counts", () => {
		const cells = bboxCoverageCells(bbox, [{ latitude: Number.NaN, longitude: -89.65 }])

		expect(cells.every((c) => c.observedRows === 0)).toBe(true)
	})

	it("is pure — identical inputs produce an identical cell set", () => {
		const rows = [{ latitude: 39.7817, longitude: -89.6501 }]

		expect(bboxCoverageCells(bbox, rows)).toEqual(bboxCoverageCells(bbox, rows))
	})
})

/**
 * The `--source osm` build-local branch: `source`/`tier` swap the manifest to build-local/ODbL
 * and `coverageCellsOverride` replaces the rows-derived coverage, including a
 * zero-observed-rows cell that must round-trip rather than be conflated with "unsurveyed".
 */
describe("buildPOIDatabase — --source osm build-local branch", () => {
	const bbox: LatLonBounds = { minLon: -89.7, minLat: 39.7, maxLon: -89.6, maxLat: 39.85 }

	function osmFixtureRows(): POISourceRow[] {
		return [
			{
				name: "Springfield exchange",
				category: "telecom_exchange",
				brandWikidata: null,
				latitude: 39.7817,
				longitude: -89.6501,
				country: "US",
				confidence: 1,
				gersID: null,
			},
			{
				name: "Springfield cabinet",
				category: "telecom_cabinet",
				brandWikidata: null,
				latitude: 39.7817,
				longitude: -89.6501,
				country: "US",
				confidence: 1,
				gersID: null,
			},
		]
	}

	it("writes a build-local ODbL manifest and round-trips a zero-observed-rows coverage cell", async () => {
		const osmRows = osmFixtureRows()
		const coverageCellsOverride = bboxCoverageCells(bbox, osmRows)

		// The fixture must actually exercise the zero-count case, or this test proves no fact.
		expect(coverageCellsOverride.some((c) => c.observedRows === 0)).toBe(true)

		const result = await buildPOIDatabase({
			rows: osmRows,
			out,
			release: "260627",
			buildSHA: "deadbeef",
			source: "osm",
			tier: LayerTier.BuildLocal,
			coverageCellsOverride,
			createdAt: "2026-07-30T00:00:00Z",
		})

		expect(result.rows).toBe(2)
		expect(result.coverageCells).toBe(coverageCellsOverride.length)

		using kdb = new DatabaseClient<POIDatabase>(out, { readOnly: true })

		const manifest = await readLayerManifest(kdb)

		expect(manifest).toMatchObject({
			name: "poi",
			tier: "build-local",
			license: "ODbL-1.0",
			source: "osm",
			sourceVintage: "260627",
			freshnessPolicy: "sealed",
		})

		expect(manifest.attribution).toMatch(/OpenStreetMap/)

		const zeroCell = coverageCellsOverride.find((c) => c.observedRows === 0)!
		const readBack = await readLayerCoverage(kdb, zeroCell.h3Cell)

		expect(readBack).toEqual({
			h3Cell: zeroCell.h3Cell,
			completeness: 1,
			basis: CoverageBasis.SourcePresent,
			observedRows: 0,
		})

		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()

		expect(coverageRows).toHaveLength(coverageCellsOverride.length)
	})

	it("default (no coverageCellsOverride) keeps the rows-derived coverage behavior unchanged", async () => {
		const osmRows = osmFixtureRows()

		const result = await buildPOIDatabase({
			rows: osmRows,
			out,
			release: "260627",
			buildSHA: "deadbeef",
			source: "osm",
			tier: LayerTier.BuildLocal,
			createdAt: "2026-07-30T00:00:00Z",
		})

		// Both fixture rows share one res-9 cell, so the rows-derived coverage produces exactly one res-6 row.
		expect(result.coverageCells).toBe(1)

		using kdb = new DatabaseClient<POIDatabase>(out, { readOnly: true })
		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()

		expect(coverageRows).toHaveLength(1)
		expect(coverageRows[0]!.observed_rows).toBe(2)
	})

	it("defaults an OSM build to the build-local tier", async () => {
		await buildPOIDatabase({
			rows: osmFixtureRows(),
			out,
			release: "260627",
			buildSHA: "deadbeef",
			source: "osm",
			createdAt: "2026-07-30T00:00:00Z",
		})

		using kdb = new DatabaseClient<POIDatabase>(out, { readOnly: true })

		expect((await readLayerManifest(kdb)).tier).toBe("build-local")
	})

	it("refuses to mark an OSM build as shipped", async () => {
		await expect(
			buildPOIDatabase({
				rows: osmFixtureRows(),
				out,
				release: "260627",
				buildSHA: "deadbeef",
				source: "osm",
				tier: LayerTier.Shipped,
			})
		).rejects.toThrow(/ODbL-1\.0.*cannot be tier "shipped"/)
	})
})

/**
 * `bboxCoverageCells` must key a row's observed count off `cellToParent(res9Cell, 6)`,
 * never a direct `latLngToCell(row, 6)`, because H3's hierarchy is not geometrically exact
 * and a builder that disagrees with its readers puts the count on a neighboring cell.
 */
const DIVERGENT_POINT = { latitude: 37.119, longitude: -79.6658 }

describe("bboxCoverageCells — builder/reader res-6 coverage-cell agreement (2b final review wave)", () => {
	const bbox: LatLonBounds = { minLon: -79.9, minLat: 37, maxLon: -79.5, maxLat: 37.3 }

	it("keys a row's observed count off cellToParent(res9Cell, 6), never a direct latLngToCell(row, 6)", () => {
		// If this point ever stops being divergent, it needs re-selecting by brute-force search.
		const oldBuggyCell = shortCellToInt(latLngToCell(DIVERGENT_POINT.latitude, DIVERGENT_POINT.longitude, 6) as H3Cell)
		const res9Cell = latLngToCell(DIVERGENT_POINT.latitude, DIVERGENT_POINT.longitude, 9) as H3Cell
		const unifiedCell = shortCellToInt(cellToParent(res9Cell, 6) as H3Cell)

		expect(unifiedCell).not.toBe(oldBuggyCell)

		const cells = bboxCoverageCells(bbox, [DIVERGENT_POINT])
		const observedByCell = new Map(cells.map((c) => [c.h3Cell, c.observedRows]))

		expect(observedByCell.get(unifiedCell)).toBe(1)

		if (observedByCell.has(oldBuggyCell)) {
			expect(observedByCell.get(oldBuggyCell)).toBe(0)
		}
	})

	it("agrees with buildPOIDatabase's own (non-override) rows-derived coverage cell for the same point", async () => {
		const row: POISourceRow = {
			name: "Divergent point POI",
			category: "cafe",
			brandWikidata: null,
			latitude: DIVERGENT_POINT.latitude,
			longitude: DIVERGENT_POINT.longitude,
			country: "US",
			confidence: 0.9,
			gersID: "gers-divergent",
		}

		const overrideCells = bboxCoverageCells(bbox, [row])
		const overrideCell = overrideCells.find((c) => c.observedRows === 1)!

		const result = await buildPOIDatabase({
			rows: [row],
			out,
			release: "2026-05-20.0",
			buildSHA: "deadbeef",
			createdAt: "2026-07-30T00:00:00Z",
		})

		expect(result.rows).toBe(1)
		expect(result.coverageCells).toBe(1)

		using kdb = new DatabaseClient<POIDatabase>(out, { readOnly: true })
		const schemadb = kdb

		const builderWrittenCoverage = await readLayerCoverage(schemadb, overrideCell.h3Cell)

		expect(builderWrittenCoverage).toEqual({
			h3Cell: overrideCell.h3Cell,
			completeness: 1,
			basis: CoverageBasis.SourcePresent,
			observedRows: 1,
		})
	})
})
