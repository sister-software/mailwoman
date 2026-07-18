/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link POILookup} — the Node reader over `poi.db` (spec §3.4). Builds a tiny fixture
 *   straight against Task 1's schema (`poi` + `poi_category_codes` + the `poi_search` FTS5 table): 3
 *   cafes at increasing distance from a Springfield, IL center, one branded McDonald's (`Q38076`),
 *   seven rows clustered ~280 km away in Chicago (a distinct res-9 cell far outside the default
 *   ring budget, including the ONLY `museum`-category rows in the fixture), and one uncategorized
 *   named row ("Pier 39") for the FTS name path. All twelve rows land in the FINAL `poi` table via
 *   typed Kysely inserts — not the `poi_stage` mirror, which is the builder's concern, not the
 *   reader's.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { haversineKm, shortenH3Cell, type H3Cell } from "@mailwoman/spatial"
import { latLngToCell } from "h3-js"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { POI_H3_RESOLUTION, POILookup } from "./poi-lookup.ts"
import {
	createPOINameKeyIndex,
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	type POIDatabase,
} from "./poi-schema.ts"

const SPRINGFIELD = { latitude: 39.7817, longitude: -89.6501 }

/** Every fixture row's h3_cell is computed here, with h3-js, from its own lat/lon — never hardcoded. */
function cellFor(latitude: number, longitude: number): number {
	const full = latLngToCell(latitude, longitude, POI_H3_RESOLUTION) as H3Cell

	return Number(BigInt(`0x${shortenH3Cell(full)}`))
}

function nameKeyFor(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

interface FixtureRow {
	name: string
	/** Poi-taxonomy category string, or `null` for an uncategorized row (category_id 0). */
	category: string | null
	brandWikidata: string | null
	latitude: number
	longitude: number
	confidence?: number
}

const CATEGORY_IDS: Record<string, number> = { cafe: 1, fast_food: 2, museum: 3 }

// 3 cafes near Springfield, increasing distance.
const CAFE_ALPHA: FixtureRow = {
	name: "Cafe Alpha",
	category: "cafe",
	brandWikidata: null,
	latitude: 39.782,
	longitude: -89.6501,
}
const CAFE_BETA: FixtureRow = {
	name: "Cafe Beta",
	category: "cafe",
	brandWikidata: null,
	latitude: 39.785,
	longitude: -89.6501,
}
const CAFE_GAMMA: FixtureRow = {
	name: "Cafe Gamma",
	category: "cafe",
	brandWikidata: null,
	latitude: 39.79,
	longitude: -89.6501,
}
// 1 branded fast-food row, also near Springfield.
const MCDONALDS: FixtureRow = {
	name: "McDonald's",
	category: "fast_food",
	brandWikidata: "Q38076",
	latitude: 39.781,
	longitude: -89.651,
}
// 7 rows ~280 km away in Chicago — a distinct res-9 cell, well outside the default ~4 km ring budget.
// Includes the fixture's ONLY `museum` rows, so a museum search from Springfield must come back empty.
const CHICAGO_ROWS: FixtureRow[] = [
	{ name: "Windy City Cafe", category: "cafe", brandWikidata: null, latitude: 41.8781, longitude: -87.6298 },
	{ name: "Loop Cafe", category: "cafe", brandWikidata: null, latitude: 41.88, longitude: -87.63 },
	{ name: "Chicago Burger Co", category: "fast_food", brandWikidata: null, latitude: 41.879, longitude: -87.628 },
	{ name: "Speedy Fries", category: "fast_food", brandWikidata: null, latitude: 41.877, longitude: -87.632 },
	{ name: "Art Institute", category: "museum", brandWikidata: null, latitude: 41.8796, longitude: -87.6237 },
	{ name: "Field Museum", category: "museum", brandWikidata: null, latitude: 41.8663, longitude: -87.6169 },
	{ name: "Shedd Wing", category: "museum", brandWikidata: null, latitude: 41.8676, longitude: -87.6153 },
]
// 1 uncategorized named row, unrelated location — the FTS name-path fixture.
const PIER_39: FixtureRow = {
	name: "Pier 39",
	category: null,
	brandWikidata: null,
	latitude: 37.8087,
	longitude: -122.4098,
}

const ALL_ROWS = [CAFE_ALPHA, CAFE_BETA, CAFE_GAMMA, MCDONALDS, ...CHICAGO_ROWS, PIER_39]

async function buildFixture(path: string): Promise<void> {
	const raw = new DatabaseSync(path)
	const kdb = new DatabaseClient<POIDatabase>({ database: raw })

	await createPOITable(kdb)
	// `createPOIStagingTables` also creates `poi_stage` — unused here, but the category-codes dictionary
	// lives alongside it and there's no standalone builder for just that table.
	await createPOIStagingTables(kdb)
	createPOISearchFTS(raw)

	for (const [category, id] of Object.entries(CATEGORY_IDS)) {
		await kdb.insertInto("poi_category_codes").values({ id, category }).execute()
	}

	let rowidKey = 1

	for (const row of ALL_ROWS) {
		const categoryId = row.category ? (CATEGORY_IDS[row.category] ?? 0) : 0
		const confidence = row.confidence ?? 0.9
		const nameKey = nameKeyFor(row.name)
		const h3Cell = cellFor(row.latitude, row.longitude)

		await kdb
			.insertInto("poi")
			.values({
				h3_cell: h3Cell,
				category_id: categoryId,
				neg_rank: 1 - confidence,
				rowid_key: rowidKey++,
				name: row.name,
				name_key: nameKey,
				brand_wikidata: row.brandWikidata,
				latitude: row.latitude,
				longitude: row.longitude,
				country: "US",
				confidence,
				gers_id: null,
			})
			.execute()

		raw.prepare(`INSERT INTO poi_search (name, name_key, h3_cell) VALUES (?, ?, ?)`).run(row.name, nameKey, h3Cell)
	}

	// Index-after-load: builders create the name_key index AFTER the bulk materialize.
	await createPOINameKeyIndex(kdb)

	await kdb.destroy()
}

let scratch: string
let dbPath: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-poi-lookup-"))
	dbPath = join(scratch, "poi.db")
	await buildFixture(dbPath)
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("POILookup", () => {
	test("category search returns cafes nearest-first with distanceM ascending", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			const hits = lk.search({ categoryID: "cafe", center: SPRINGFIELD, limit: 10 })
			expect(hits.map((h) => h.name)).toEqual(["Cafe Alpha", "Cafe Beta", "Cafe Gamma"])
			expect(hits[0]!.distanceM).toBeLessThan(hits[1]!.distanceM!)
			expect(hits[1]!.distanceM).toBeLessThan(hits[2]!.distanceM!)
			// Sanity: the app-level distance matches a plain haversine of the same pair.
			expect(hits[0]!.distanceM).toBeCloseTo(
				haversineKm(SPRINGFIELD.latitude, SPRINGFIELD.longitude, CAFE_ALPHA.latitude, CAFE_ALPHA.longitude) * 1000,
				0
			)
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("brand search finds the QID row (category unconstrained)", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			const hits = lk.search({ brandWikidata: "Q38076", center: SPRINGFIELD })
			expect(hits).toHaveLength(1)
			expect(hits[0]!.name).toBe("McDonald's")
			expect(hits[0]!.brandWikidata).toBe("Q38076")
			expect(hits[0]!.categoryID).toBe("fast_food")
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("name FTS finds 'Pier 39' with no center required", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			const hits = lk.search({ name: "Pier 39" })
			expect(hits.some((h) => h.name === "Pier 39")).toBe(true)
			const pier = hits.find((h) => h.name === "Pier 39")!
			expect(pier.categoryID).toBeNull()
			expect(pier.distanceM).toBeUndefined()
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("name FTS still sorts by distance when a center is given", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			const hits = lk.search({ name: "Cafe", center: SPRINGFIELD })
			// Every "Cafe"-named row matches (Alpha/Beta/Gamma near, Windy City/Loop Cafe far) — near ones first.
			expect(hits[0]!.distanceM).toBeLessThanOrEqual(hits[hits.length - 1]!.distanceM!)
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("category/brand search without a center throws", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			expect(() => lk.search({ categoryID: "cafe" })).toThrow(/center/)
			expect(() => lk.search({ brandWikidata: "Q38076" })).toThrow(/center/)
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("limit is respected", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			const hits = lk.search({ categoryID: "cafe", center: SPRINGFIELD, limit: 2 })
			expect(hits).toHaveLength(2)
			expect(hits.map((h) => h.name)).toEqual(["Cafe Alpha", "Cafe Beta"])
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("a category with no rows within maxRings returns []", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			// The only `museum` rows in the fixture sit ~280 km away in Chicago — far outside the
			// default ~4 km (12-ring) budget from Springfield.
			expect(lk.search({ categoryID: "museum", center: SPRINGFIELD })).toEqual([])
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("an unknown category id is a clean miss, not a throw", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			expect(lk.search({ categoryID: "zoo", center: SPRINGFIELD })).toEqual([])
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("the name_key index exists (FTS-hydration path, not a full table scan)", () => {
		const raw = new DatabaseSync(dbPath, { readOnly: true })

		try {
			const found = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("poi_name_key")
			expect(found).toBeDefined()
		} finally {
			raw.close()
		}
	})

	test("Disposable: Symbol.dispose closes the lookup", () => {
		const lk = new POILookup({ databasePath: dbPath })
		lk[Symbol.dispose]()
		expect(() => lk.search({ name: "Pier 39" })).toThrow()
	})
})
