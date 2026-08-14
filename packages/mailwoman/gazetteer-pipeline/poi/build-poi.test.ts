/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildPOIDatabase} — the load/materialize/seal phase of `poi.db` (spec §3.4).
 *   Feeds the loader a synthetic row source directly (an injected `Iterable<POISourceRow>`), so the
 *   suite exercises the whole build WITHOUT touching DuckDB/network — `ingestPlaces` (the Overture
 *   S3 parquet phase) is covered separately, and its schema-probe logic is exercised as a pure
 *   function over `DESCRIBE` rows in `overture-places-schema.test.ts`.
 *
 *   Fixture: 30 rows across 2 countries (US, FR) × 3 categories (cafe, restaurant, museum), 5 rows
 *   per (country, category) pair at ~3m lat jitter (well inside a res-9 cell, so a group clusters
 *   into the SAME `h3_cell`) with 5 distinct confidence values — plus 2 rows with non-finite
 *   coordinates the loader must skip (and count) rather than insert.
 */

import { statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { LayerTier, readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import type { LayerContractDatabase } from "@mailwoman/core/layers"
import { POILookup } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import type { POICategoryCodeTable, POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { cellToParent, latLngToCell } from "h3-js"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { bboxCoverageCells, buildPOIDatabase, type BBox, type POISourceRow } from "./build-poi.ts"

const SPRINGFIELD = { latitude: 39.7817, longitude: -89.6501, country: "US" as const }
const PARIS = { latitude: 48.8566, longitude: 2.3522, country: "FR" as const }
const CATEGORIES = ["cafe", "restaurant", "museum"] as const
/**
 * ~3m lat steps — well under a res-9 hex's ~174m edge, so a (country, category) group clusters into one cell.
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

	// Non-finite coordinates — the loader must SKIP + count these, never insert garbage.
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

let scratch: string
let out: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "poi-build-"))
	out = join(scratch, "poi.db")
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

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
		// Per-country counts: 15 rows kept for each of US/FR (3 categories × 5 rows) — the 2 skipped
		// non-finite-coordinate rows (both nominally "US") are NOT counted, per the Map's contract.
		expect(Object.fromEntries(result.countries)).toEqual({ US: 15, FR: 15 })

		// --- sealed: no write bits ---
		expect(statSync(out).mode & 0o222).toBe(0)

		// `kdb`'s dispose closes the underlying connection — don't ALSO `using` `raw`, or both dispose
		// paths race to close() the same DatabaseSync and one throws "database is not open".
		const raw = new DatabaseSync(out, { readOnly: true })
		using kdb = new DatabaseClient<POIDatabase>({ database: raw })

		// --- dictionary round-trip: insert-on-first-sight, 0 reserved for uncategorized ---
		const codes = (await kdb.selectFrom("poi_category_codes").selectAll().execute()) as POICategoryCodeTable[]
		expect(codes.map((c) => c.category).toSorted()).toEqual(["cafe", "museum", "restaurant"])
		expect(codes.every((c) => c.id > 0)).toBe(true)
		const cafeID = codes.find((c) => c.category === "cafe")!.id

		// --- clustered order on disk: the (h3_cell, category_id) group's FIRST physical row (no
		// ORDER BY — relying on the WITHOUT ROWID clustered-key order) is the best-confidence one. ---
		const group = await kdb
			.selectFrom("poi")
			.select(["h3_cell", "confidence"])
			.where("category_id", "=", cafeID)
			.where("country", "=", "US")
			.execute()

		expect(group).toHaveLength(5)
		const clusterCell = group[0]!.h3_cell
		expect(group.every((r) => r.h3_cell === clusterCell)).toBe(true)

		// all 5 jittered into one res-9 cell

		const firstPhysicalRow = await kdb
			.selectFrom("poi")
			.select(["confidence"])
			.where("h3_cell", "=", clusterCell)
			.where("category_id", "=", cafeID)
			.executeTakeFirstOrThrow()

		const maxConfidence = Math.max(...group.map((r) => r.confidence))
		expect(firstPhysicalRow.confidence).toBeCloseTo(maxConfidence, 10)

		// --- manifest reads back valid ---
		const manifest = await readLayerManifest(kdb as unknown as Kysely<LayerContractDatabase>)

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
		})

		// --- coverage rows exist at res 6 ---
		expect(result.coverageCells).toBeGreaterThan(0)
		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()
		expect(coverageRows).toHaveLength(result.coverageCells)
		expect(coverageRows.every((c) => c.observed_rows > 0 && c.completeness === 1)).toBe(true)
		const totalObserved = coverageRows.reduce((sum, c) => sum + c.observed_rows, 0)
		expect(totalObserved).toBe(30)
		// Meaning-of-zero: an unsurveyed cell is UNKNOWN, never present with completeness 0.
		expect(await readLayerCoverage(kdb as unknown as Kysely<LayerContractDatabase>, 999_999_999)).toBeUndefined()

		// --- end-to-end via the POILookup reader ---
		using lookup = new POILookup({ databasePath: out })
		const cafeHits = lookup.search({ categoryID: "cafe", center: SPRINGFIELD, limit: 5 })
		expect(cafeHits.length).toBeGreaterThan(0)
		expect(cafeHits.every((h) => h.name?.startsWith("US cafe"))).toBe(true)
		// Nearest (n=0) row carries the highest confidence in the fixture too.
		expect(cafeHits[0]!.confidence).toBeCloseTo(0.85, 10)

		const brandHits = lookup.search({ brandWikidata: "Q00000", center: SPRINGFIELD, limit: 10 })
		expect(brandHits.some((h) => h.brandWikidata === "Q00000")).toBe(true)

		const nameHits = lookup.search({ name: "restaurant" })
		expect(nameHits.some((h) => h.name?.includes("restaurant"))).toBe(true)
	})

	it("bootstraps missing intermediate output directories", async () => {
		const nestedOut = join(scratch, "nested", "deeper", "poi.db")

		const result = await buildPOIDatabase({
			rows: fixtureRows(),
			out: nestedOut,
			release: "2026-05-20.0",
			buildSHA: "deadbeef",
			createdAt: "2026-07-18T00:00:00Z",
		})

		expect(result.rows).toBe(30)
		expect(statSync(nestedOut).isFile()).toBe(true)
	})
})

/**
 * Extract-bbox coverage polyfill (decision 5) — the pure seam `--source osm` uses in place of the Overture path's
 * "rows-present ⇒ 1" coverage. Springfield IL sits well inside this small bbox; the bbox spans several res-6 cells, so
 * an empty `rows` list (or rows clustered in only one spot) always leaves at least one cell with `observedRows: 0` to
 * exercise decision 5's "well-surveyed, none found" case.
 */
describe("bboxCoverageCells", () => {
	const bbox: BBox = { minLon: -89.7, minLat: 39.7, maxLon: -89.6, maxLat: 39.85 }

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
		// At least one polyfilled cell saw no rows — decision 5's zero-permitted case.
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
 * The `--source osm` build-local branch (decisions 3/5): same `rows:` injection seam as the default Overture path, but
 * `source`/`tier` swap the manifest to build-local/ODbL and `coverageCellsOverride` replaces the rows-derived coverage
 * with the bbox polyfill above — including a zero-observed-rows cell, which must round-trip through
 * `writeLayerCoverage` / `readLayerCoverage` (never silently dropped, never conflated with "unsurveyed").
 */
describe("buildPOIDatabase — --source osm build-local branch", () => {
	const bbox: BBox = { minLon: -89.7, minLat: 39.7, maxLon: -89.6, maxLat: 39.85 }

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

		// Sanity: the fixture must actually exercise the zero-count case, or this test proves nothing.
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

		const raw = new DatabaseSync(out, { readOnly: true })
		using kdb = new DatabaseClient<POIDatabase>({ database: raw })

		const manifest = await readLayerManifest(kdb as unknown as Kysely<LayerContractDatabase>)

		expect(manifest).toMatchObject({
			name: "poi",
			tier: "build-local",
			license: "ODbL-1.0",
			source: "osm",
			sourceVintage: "260627",
			freshnessPolicy: "sealed",
		})

		expect(manifest.attribution).toMatch(/OpenStreetMap/)

		// --- Gate-relevant: the zero-observed-rows cell must round-trip, never read back as undefined ---
		const zeroCell = coverageCellsOverride.find((c) => c.observedRows === 0)!
		const readBack = await readLayerCoverage(kdb as unknown as Kysely<LayerContractDatabase>, zeroCell.h3Cell)

		expect(readBack).toEqual({ h3Cell: zeroCell.h3Cell, completeness: 1, observedRows: 0 })

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

		// Both fixture rows share one res-9 cell -> one res-6 parent -> exactly one coverage row, matching
		// the Overture path's "rows-present only" behavior when no override is supplied.
		expect(result.coverageCells).toBe(1)

		const raw = new DatabaseSync(out, { readOnly: true })
		using kdb = new DatabaseClient<POIDatabase>({ database: raw })
		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()

		expect(coverageRows).toHaveLength(1)
		expect(coverageRows[0]!.observed_rows).toBe(2)
	})
})

/**
 * Builder/reader res-6 coverage-cell agreement — `bboxCoverageCells` (the `--source osm` build branch's coverage
 * aggregator, decision 5) must key a row's observed count off `cellToParent(res9Cell, 6)`, never a direct
 * `latLngToCell(row, 6)`: the default (non-override) rows-derived coverage path just above in this same file's
 * `buildPOIDatabase` (~:592) and every layer reader (`res9ShortCellToRes6Parent` in `bdc/sdk/filing-landscape.ts`,
 * `plausibility.ts`, `nearest-infrastructure.ts`) derive it the parent way, and a builder that disagrees with its
 * readers about the spine is the recurring failure class here. H3's cell hierarchy is not geometrically exact, so the
 * two derivations disagree for a real fraction of points (~6.56% measured over 20k CONUS points): a row's observed
 * count could land on a neighbouring cell, or be dropped entirely when its direct-res-6 cell isn't a member of the bbox
 * polyfill.
 *
 * `DIVERGENT_POINT` is reused verbatim from `bdc/sdk/filing-landscape.test.ts`'s own brute-force-found divergent point
 * — the H3 math is generic (no domain data involved), so the exact same coordinate reproduces the exact same res-6
 * divergence regardless of which layer is asking.
 */
const DIVERGENT_POINT = { latitude: 37.119, longitude: -79.6658 }

describe("bboxCoverageCells — builder/reader res-6 coverage-cell agreement (2b final review wave)", () => {
	const bbox: BBox = { minLon: -79.9, minLat: 37, maxLon: -79.5, maxLat: 37.3 }

	it("keys a row's observed count off cellToParent(res9Cell, 6), never a direct latLngToCell(row, 6)", () => {
		// Prove this point is genuinely divergent BEFORE trusting the rest of the test — if this assertion ever
		// stops holding (e.g. an h3-js upgrade changes cell boundaries), the point needs re-selecting via a fresh
		// brute-force search, exactly as noted in filing-landscape.test.ts.
		const oldBuggyCell = shortCellToInt(latLngToCell(DIVERGENT_POINT.latitude, DIVERGENT_POINT.longitude, 6) as H3Cell)
		const res9Cell = latLngToCell(DIVERGENT_POINT.latitude, DIVERGENT_POINT.longitude, 9) as H3Cell
		const unifiedCell = shortCellToInt(cellToParent(res9Cell, 6) as H3Cell)

		expect(unifiedCell).not.toBe(oldBuggyCell)

		const cells = bboxCoverageCells(bbox, [DIVERGENT_POINT])
		const observedByCell = new Map(cells.map((c) => [c.h3Cell, c.observedRows]))

		// The row must land on the UNIFIED (res-9-parent) cell...
		expect(observedByCell.get(unifiedCell)).toBe(1)

		// ...never on the old direct-latLngToCell(_, 6) cell, if that (different) cell even appears in this
		// bbox's polyfill at all.
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

		// The OSM branch's coverage aggregator (over the SAME row) — what this test pins.
		const overrideCells = bboxCoverageCells(bbox, [row])
		const overrideCell = overrideCells.find((c) => c.observedRows === 1)!

		// The default (Overture) branch's rows-derived coverage — already correct (~:592) — built independently
		// via the real `buildPOIDatabase` seam over the exact same row.
		const result = await buildPOIDatabase({
			rows: [row],
			out,
			release: "2026-05-20.0",
			buildSHA: "deadbeef",
			createdAt: "2026-07-30T00:00:00Z",
		})

		expect(result.rows).toBe(1)
		expect(result.coverageCells).toBe(1)

		const raw = new DatabaseSync(out, { readOnly: true })
		using kdb = new DatabaseClient<POIDatabase>({ database: raw })
		const contractDB = kdb as unknown as Kysely<LayerContractDatabase>

		const builderWrittenCoverage = await readLayerCoverage(contractDB, overrideCell.h3Cell)

		// The builder's/reader's agreement, pinned: the OSM branch's coverage cell for this row is the SAME cell
		// the default branch actually wrote coverage under — reverting the `bboxCoverageCells` fix makes
		// `overrideCell.h3Cell` the old buggy direct-res-6 cell, which the default branch never writes to, so
		// this read comes back `undefined` and the assertion below fails.
		expect(builderWrittenCoverage).toEqual({ h3Cell: overrideCell.h3Cell, completeness: 1, observedRows: 1 })
	})
})
