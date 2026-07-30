/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link nearestInfrastructure} (2b task 4, decision 7). The fixture `poi.db` is built via
 *   the rows seam directly against Task 1's schema (`poi-schema.ts`) — the SAME idiom
 *   `resolver-wof-sqlite/poi-lookup.test.ts` uses (a tiny hand-built `poi`/`poi_category_codes` fixture,
 *   no DuckDB/network) — rather than `mailwoman/gazetteer-pipeline/poi/build-poi.ts`'s
 *   `buildPOIDatabase`: `bdc` cannot depend on the `mailwoman` workspace (the top-level CLI package
 *   already depends on `@mailwoman/bdc`, so the reverse edge would be circular), and the task brief's own
 *   dependency line only adds `@mailwoman/resolver-wof-sqlite` to `bdc`. Deviation from the brief's
 *   literal "`buildPOIDatabase`" wording, documented per its own "implementer picks and documents" rule
 *   — the ROWS-SEAM idiom itself (inject synthetic rows, skip DuckDB entirely) is preserved exactly.
 *
 *   Fixture rows, all telecom_exchange/tower_comms (poi-taxonomy task 1) except one deliberate
 *   non-telecom trap:
 *
 *   - Two rows a few hundred meters from a Springfield, IL center (`TELECOM_EXCHANGE_NEAR` closer,
 *     `TOWER_COMMS_NEAR` further).
 *   - One `telecom_exchange` row at EXACTLY res-9 gridDistance 20 from the center — inside this module's
 *     32-ring default (covers gridDistance ≤ 31) but OUTSIDE `POILookup`'s own internal default of 16
 *     rings (covers gridDistance ≤ 15). This is the direct acceptance test for the task brief's "maxRings
 *     default 32" deviation from `POILookup`'s own default — see `nearest-infrastructure.ts`'s docstring.
 *   - A `cafe` row (non-telecom) right next to the near rows, proving `categoryIDs` filtering isn't
 *     accidentally permissive.
 *
 *   `contractDB` fixtures are separate, minimal `LayerContractDatabase`-only databases (no `poi` table at
 *   all) — proving the coverage join runs against WHATEVER database the caller passes, not poi.db's own
 *   coverage. One fixture's `layer_coverage` is left completely empty (every hit must report
 *   `coverage: undefined`, the meaning-of-zero rule); another has coverage written for exactly the res-6
 *   cells the hits actually land in (computed via the same `res9ShortCellToRes6Parent`
 *   {@link nearestInfrastructure} itself uses, cross-checked against a direct `readLayerCoverage` call).
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	readLayerCoverage,
	writeLayerCoverage,
	writeLayerManifest,
	type LayerContractDatabase,
} from "@mailwoman/core/layers"
import { POI_H3_RESOLUTION, POILookup } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import {
	createPOIBrandIndex,
	createPOINameKeyIndex,
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	type POIDatabase,
} from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { cellToLatLng, gridRingUnsafe, latLngToCell } from "h3-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { res9ShortCellToRes6Parent } from "./filing-landscape.ts"
import { nearestInfrastructure, NEAREST_INFRASTRUCTURE_DEFAULT_MAX_RINGS } from "./nearest-infrastructure.ts"

const SPRINGFIELD = { latitude: 39.7817, longitude: -89.6501 }

const SPRINGFIELD_ORIGIN = latLngToCell(SPRINGFIELD.latitude, SPRINGFIELD.longitude, POI_H3_RESOLUTION) as H3Cell

const SPRINGFIELD_CENTER = {
	type: "Point" as const,
	coordinates: [SPRINGFIELD.longitude, SPRINGFIELD.latitude] as [number, number],
}

// A REMOTE center, ~280 km from Springfield — far outside even this module's 32-ring (~11 km) default,
// and with no fixture rows anywhere nearby. The sparse-result acceptance case.
const REMOTE = { latitude: 41.8781, longitude: -87.6298 }

// Exactly gridDistance 20 from the Springfield origin cell — inside the 32-ring default (covers ≤ 31),
// outside POILookup's own internal default of 16 rings (covers ≤ 15). Derived from h3-js, never
// hardcoded, matching poi-lookup.test.ts's TRAIL_SPARSE discipline.
const MID_RING_GRID_DISTANCE = 20
const [MID_RING_LAT, MID_RING_LNG] = cellToLatLng(gridRingUnsafe(SPRINGFIELD_ORIGIN, MID_RING_GRID_DISTANCE)[0]!)

interface FixtureRow {
	name: string
	category: string
	latitude: number
	longitude: number
	confidence?: number
}

const TELECOM_EXCHANGE_NEAR: FixtureRow = {
	name: "Central Office 12",
	category: "telecom_exchange",
	latitude: 39.782,
	longitude: -89.6501,
	confidence: 0.92,
}

const TOWER_COMMS_NEAR: FixtureRow = {
	name: "Comm Tower Alpha",
	category: "tower_comms",
	latitude: 39.785,
	longitude: -89.6501,
	confidence: 0.9,
}

const TELECOM_EXCHANGE_MID_RING: FixtureRow = {
	name: "Central Office Outpost",
	category: "telecom_exchange",
	latitude: MID_RING_LAT,
	longitude: MID_RING_LNG,
	confidence: 0.88,
}

// A non-telecom row right next to the near rows — proves categoryIDs filtering isn't accidentally
// permissive (a plain nearest-POI scan would surface this; nearestInfrastructure must not).
const CAFE_TRAP: FixtureRow = {
	name: "Cafe Not Infrastructure",
	category: "cafe",
	latitude: 39.7815,
	longitude: -89.6501,
	confidence: 0.95,
}

const ALL_ROWS: FixtureRow[] = [TELECOM_EXCHANGE_NEAR, TOWER_COMMS_NEAR, TELECOM_EXCHANGE_MID_RING, CAFE_TRAP]

const TELECOM_CATEGORY_IDS = ["telecom_exchange", "tower_comms"]

const CATEGORY_IDS: Record<string, number> = { telecom_exchange: 1, tower_comms: 2, cafe: 3 }

function cellFor(latitude: number, longitude: number): number {
	const full = latLngToCell(latitude, longitude, POI_H3_RESOLUTION) as H3Cell

	return shortCellToInt(full)
}

function nameKeyFor(name: string): string {
	return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
}

/**
 * Builds a minimal poi.db fixture straight against `poi-schema.ts` (the `poi-lookup.test.ts` idiom) — NOT
 * `buildPOIDatabase`, see this file's header docstring for why.
 */
async function buildPOIFixture(path: string, rows: readonly FixtureRow[]): Promise<void> {
	const raw = new DatabaseSync(path)
	const kdb = new DatabaseClient<POIDatabase>({ database: raw })

	await createPOITable(kdb)
	// `createPOIStagingTables` also creates `poi_stage` (unused here) — the category-codes dictionary
	// lives alongside it and there's no standalone builder for just that table.
	await createPOIStagingTables(kdb)
	// POILookup's constructor unconditionally prepares a statement against `poi_search` — the FTS5 table
	// must exist even though these tests never search by name.
	createPOISearchFTS(raw)

	for (const [category, id] of Object.entries(CATEGORY_IDS)) {
		await kdb.insertInto("poi_category_codes").values({ id, category }).execute()
	}

	let rowidKey = 1

	for (const row of rows) {
		const categoryId = CATEGORY_IDS[row.category] ?? 0
		const confidence = row.confidence ?? 0.9

		await kdb
			.insertInto("poi")
			.values({
				h3_cell: cellFor(row.latitude, row.longitude),
				category_id: categoryId,
				neg_rank: 1 - confidence,
				rowid_key: rowidKey++,
				name: row.name,
				name_key: nameKeyFor(row.name),
				brand_wikidata: null,
				latitude: row.latitude,
				longitude: row.longitude,
				country: "US",
				confidence,
				gers_id: null,
			})
			.execute()
	}

	// Index-after-load, matching the builder's own discipline (poi-schema.ts / poi-lookup.test.ts).
	await createPOINameKeyIndex(kdb)
	await createPOIBrandIndex(kdb)

	await kdb.destroy()
}

/**
 * A minimal `LayerContractDatabase`-only fixture — NOT poi.db's own coverage table. Proves the coverage join runs
 * against whatever database the caller passes, independent of poi.db's own coverage.
 */
async function openEmptyContractDB(): Promise<DatabaseClient<LayerContractDatabase>> {
	const kdb = new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(":memory:") })

	await createLayerManifestTable(kdb)
	await createLayerCoverageTable(kdb)

	await writeLayerManifest(kdb, {
		name: "test-coverage-layer",
		version: "0.0.0-test",
		schemaVersion: 1,
		tier: "private",
		license: "CDLA-Permissive-2.0",
		source: "test-fixture",
		sourceVintage: "2026-07-30",
		buildCmd: "test",
		buildSHA: "deadbeef",
		freshnessPolicy: "sealed",
		spineKeys: { h3: { column: "h3_cell", resolution: 6 } },
		createdAt: "2026-07-30T00:00:00Z",
	})

	return kdb
}

let scratch: string
let poiDBPath: string

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "bdc-nearest-infrastructure-"))
	poiDBPath = join(scratch, "poi.db")

	await buildPOIFixture(poiDBPath, ALL_ROWS)
})

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true })
})

describe("nearestInfrastructure", () => {
	it("returns telecom infrastructure nearest-first, excluding non-telecom categories", async () => {
		using poiLookup = new POILookup({ databasePath: poiDBPath })
		using contractDB = await openEmptyContractDB()

		const hits = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: TELECOM_CATEGORY_IDS,
		})

		// The cafe trap must never surface — categoryIDs filtering, not a plain nearest-POI scan.
		expect(hits.every((h) => TELECOM_CATEGORY_IDS.includes(h.categoryID))).toBe(true)
		expect(hits.some((h) => h.name === CAFE_TRAP.name)).toBe(false)

		// Nearest-first: NEAR (~30 m) < TOWER (~370 m) < MID_RING (gridDistance 20, several km).
		expect(hits.map((h) => h.name)).toEqual([
			TELECOM_EXCHANGE_NEAR.name,
			TOWER_COMMS_NEAR.name,
			TELECOM_EXCHANGE_MID_RING.name,
		])

		for (let i = 1; i < hits.length; i++) {
			expect(hits[i]!.distanceM).toBeGreaterThanOrEqual(hits[i - 1]!.distanceM!)
		}

		// h3Cell round-trips against an independently-computed cell for the nearest hit.
		const nearHit = hits[0]!
		expect(nearHit.h3Cell).toBe(cellFor(TELECOM_EXCHANGE_NEAR.latitude, TELECOM_EXCHANGE_NEAR.longitude))
	})

	it("reports coverage: undefined for every hit when the layer has never surveyed anywhere (meaning-of-zero)", async () => {
		using poiLookup = new POILookup({ databasePath: poiDBPath })
		using contractDB = await openEmptyContractDB()

		const hits = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: TELECOM_CATEGORY_IDS,
		})

		expect(hits.length).toBeGreaterThan(0)
		expect(hits.every((h) => h.coverage === undefined)).toBe(true)
	})

	it("pairs each hit with the coverage cell it actually falls in, once the layer has surveyed it", async () => {
		using poiLookup = new POILookup({ databasePath: poiDBPath })
		using contractDB = await openEmptyContractDB()

		// Discover which res-6 cells the hits land in (via the SAME reconstruction nearestInfrastructure
		// itself uses), then write coverage for exactly those cells — robust regardless of whether the
		// fixture's near/mid rows happen to share one res-6 parent or straddle a boundary.
		const uncoveredHits = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: TELECOM_CATEGORY_IDS,
		})

		const res6Cells = [...new Set(uncoveredHits.map((h) => res9ShortCellToRes6Parent(h.h3Cell)))]

		await writeLayerCoverage(
			contractDB,
			res6Cells.map((h3Cell) => ({ h3Cell, completeness: 0.75, observedRows: 42 }))
		)

		const coveredHits = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: TELECOM_CATEGORY_IDS,
		})

		expect(coveredHits).toHaveLength(uncoveredHits.length)

		for (const hit of coveredHits) {
			expect(hit.coverage).toBeDefined()

			expect(hit.coverage).toEqual({
				h3Cell: res9ShortCellToRes6Parent(hit.h3Cell),
				completeness: 0.75,
				observedRows: 42,
			})

			// Cross-check against a direct readLayerCoverage call, not just the wrapper's own math.
			const direct = await readLayerCoverage(contractDB, res9ShortCellToRes6Parent(hit.h3Cell))
			expect(hit.coverage).toEqual(direct)
		}
	})

	it("maxRings default (32) reaches the gridDistance-20 hit that POILookup's own internal default (16) would miss", async () => {
		using poiLookup = new POILookup({ databasePath: poiDBPath })
		using contractDB = await openEmptyContractDB()

		const withDefault = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: ["telecom_exchange"],
		})

		expect(withDefault.map((h) => h.name)).toContain(TELECOM_EXCHANGE_MID_RING.name)

		const withExplicit16 = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: ["telecom_exchange"],
			maxRings: 16,
		})

		expect(withExplicit16.map((h) => h.name)).not.toContain(TELECOM_EXCHANGE_MID_RING.name)
		expect(withExplicit16.map((h) => h.name)).toEqual([TELECOM_EXCHANGE_NEAR.name])

		expect(NEAREST_INFRASTRUCTURE_DEFAULT_MAX_RINGS).toBe(32)
	})

	it("limit is respected", async () => {
		using poiLookup = new POILookup({ databasePath: poiDBPath })
		using contractDB = await openEmptyContractDB()

		const hits = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: TELECOM_CATEGORY_IDS,
			limit: 1,
		})

		expect(hits).toHaveLength(1)
		expect(hits[0]!.name).toBe(TELECOM_EXCHANGE_NEAR.name)
	})

	it("a center far from every telecom row returns [] rather than throwing (sparse case)", async () => {
		using poiLookup = new POILookup({ databasePath: poiDBPath })
		using contractDB = await openEmptyContractDB()

		const hits = await nearestInfrastructure(poiLookup, contractDB, {
			center: { type: "Point", coordinates: [REMOTE.longitude, REMOTE.latitude] },
			categoryIDs: TELECOM_CATEGORY_IDS,
		})

		expect(hits).toEqual([])
	})

	it("an empty categoryIDs array returns [] rather than throwing", async () => {
		using poiLookup = new POILookup({ databasePath: poiDBPath })
		using contractDB = await openEmptyContractDB()

		const hits = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: [],
		})

		expect(hits).toEqual([])
	})

	it("categoryIDs the dictionary doesn't carry are a clean miss, not a throw", async () => {
		using poiLookup = new POILookup({ databasePath: poiDBPath })
		using contractDB = await openEmptyContractDB()

		const hits = await nearestInfrastructure(poiLookup, contractDB, {
			center: SPRINGFIELD_CENTER,
			categoryIDs: ["zoo", "aquarium"],
		})

		expect(hits).toEqual([])
	})
})
