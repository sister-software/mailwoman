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
import { cellToLatLng, gridRingUnsafe, latLngToCell } from "h3-js"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { POI_H3_RESOLUTION, POILookup } from "./poi-lookup.ts"
import {
	createPOIBrandIndex,
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
	gersID?: string | null
}

const CATEGORY_IDS: Record<string, number> = { cafe: 1, fast_food: 2, museum: 3, supermarket: 4, trail: 5 }

// A SPARSE-category instance placed at EXACTLY gridDistance 13 from the Springfield origin cell — the nm-04 boundary. A
// res-9 disk of radius r covers gridDistance ≤ r, and the reader's loop over `maxRings` rings covers gridDistance ≤
// `maxRings - 1`; so this cell first appears at maxRings 14 and is MISSED by the old 12-ring default (covers ≤ 11). The
// coordinate is derived from h3-js (a real ring-13 cell's center), never hardcoded — same discipline as `cellFor`. This
// mirrors "hiking trail near Marseille", whose nearest `trail` sits at gridDistance 13 (~3.9 km) in the real poi.db.
const TRAIL_GRID_DISTANCE = 13
const SPRINGFIELD_ORIGIN = latLngToCell(SPRINGFIELD.latitude, SPRINGFIELD.longitude, POI_H3_RESOLUTION) as H3Cell
const [TRAIL_LAT, TRAIL_LNG] = cellToLatLng(gridRingUnsafe(SPRINGFIELD_ORIGIN, TRAIL_GRID_DISTANCE)[0]!)
const TRAIL_SPARSE: FixtureRow = {
	name: "Ridge Trail",
	category: "trail",
	brandWikidata: null,
	latitude: TRAIL_LAT,
	longitude: TRAIL_LNG,
}

// 3 cafes near Springfield, increasing distance.
const CAFE_ALPHA: FixtureRow = {
	name: "Cafe Alpha",
	category: "cafe",
	brandWikidata: null,
	latitude: 39.782,
	longitude: -89.6501,
	gersID: "08f2836a5411a2ff0300b0a0a0a0a0a0",
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
// 1 branded fast-food row, near Springfield (McDonald's, Q38076).
const MCDONALDS: FixtureRow = {
	name: "McDonald's",
	category: "fast_food",
	brandWikidata: "Q38076",
	latitude: 39.781,
	longitude: -89.651,
}
// A SECOND McDonald's (same Q38076) ~280 km away in Chicago — far outside the default ~4 km ring budget. The brand
// path is a brand-wide fetch (no k-ring), so both must surface, distance-sorted (Springfield one first).
const MCDONALDS_CHICAGO: FixtureRow = {
	name: "McDonald's (Loop)",
	category: "fast_food",
	brandWikidata: "Q38076",
	latitude: 41.8805,
	longitude: -87.6299,
}
// Costco (Q715583): one near Springfield, one ~2,800 km away in San Francisco. The SF one is past the 500 km sanity
// radius, so a Costco brand search from Springfield returns ONLY the near one.
const COSTCO_NEAR: FixtureRow = {
	name: "Costco Springfield",
	category: "supermarket",
	brandWikidata: "Q715583",
	latitude: 39.783,
	longitude: -89.652,
}
const COSTCO_FAR: FixtureRow = {
	name: "Costco SF",
	category: "supermarket",
	brandWikidata: "Q715583",
	latitude: 37.7749,
	longitude: -122.4194,
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

const ALL_ROWS = [
	CAFE_ALPHA,
	CAFE_BETA,
	CAFE_GAMMA,
	MCDONALDS,
	MCDONALDS_CHICAGO,
	COSTCO_NEAR,
	COSTCO_FAR,
	...CHICAGO_ROWS,
	TRAIL_SPARSE,
	PIER_39,
]

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
				gers_id: row.gersID ?? null,
			})
			.execute()

		raw.prepare(`INSERT INTO poi_search (name, name_key, h3_cell) VALUES (?, ?, ?)`).run(row.name, nameKey, h3Cell)
	}

	// Index-after-load: builders create the name_key + brand_wikidata indexes AFTER the bulk materialize.
	await createPOINameKeyIndex(kdb)
	await createPOIBrandIndex(kdb)

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
			// gers_id round-trips: Cafe Alpha was seeded with one, the others with null.
			expect(hits[0]!.gersID).toBe(CAFE_ALPHA.gersID)
			expect(hits[1]!.gersID).toBeNull()
			// Sanity: the app-level distance matches a plain haversine of the same pair.
			expect(hits[0]!.distanceM).toBeCloseTo(
				haversineKm(SPRINGFIELD.latitude, SPRINGFIELD.longitude, CAFE_ALPHA.latitude, CAFE_ALPHA.longitude) * 1000,
				0
			)
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("brand search finds the QID rows (category unconstrained), nearest-first", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			const hits = lk.search({ brandWikidata: "Q38076", center: SPRINGFIELD })
			// Both Q38076 rows surface: the near Springfield one AND the ~280 km Chicago one — the brand path is a
			// brand-wide fetch, not a k-ring walk, so the Chicago row (far outside the ~4 km ring budget) is reached.
			expect(hits.map((h) => h.name)).toEqual(["McDonald's", "McDonald's (Loop)"])
			expect(hits.every((h) => h.brandWikidata === "Q38076")).toBe(true)
			expect(hits[0]!.categoryID).toBe("fast_food")
			expect(hits[0]!.distanceM).toBeLessThan(hits[1]!.distanceM!)
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("brand search reaches instances far beyond any k-ring budget (distance-sorted)", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			// The Chicago McDonald's is ~280 km from Springfield — hundreds of rings out. k-ring could never reach it;
			// the brand-wide fetch returns it, and its reported distance confirms it's the far instance.
			const hits = lk.search({ brandWikidata: "Q38076", center: SPRINGFIELD })
			const chicago = hits.find((h) => h.name === "McDonald's (Loop)")!
			expect(chicago).toBeDefined()
			expect(chicago.distanceM! / 1000).toBeGreaterThan(200)
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("brand search drops instances past the 500 km sanity radius", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			// Two Costco (Q715583) rows: one near Springfield, one ~2,800 km away in SF. Only the near one is within
			// the sanity radius — the SF one is dropped, so "Costco near Springfield" is not answered with an SF hit.
			const hits = lk.search({ brandWikidata: "Q715583", center: SPRINGFIELD })
			expect(hits.map((h) => h.name)).toEqual(["Costco Springfield"])
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("a brand QID with no rows returns [] cleanly", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			expect(lk.search({ brandWikidata: "Q00000000", center: SPRINGFIELD })).toEqual([])
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
			// default ~5.4 km (16-ring) budget from Springfield.
			expect(lk.search({ categoryID: "museum", center: SPRINGFIELD })).toEqual([])
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("sparse category: the default budget reaches a gridDistance-13 instance the old 12-ring budget missed (nm-04)", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			// The single `trail` row sits exactly 13 rings out — the nm-04 "hiking trail near Marseille" boundary.
			// The default budget (16 rings, covers gridDistance ≤ 15) reaches it.
			expect(lk.search({ categoryID: "trail", center: SPRINGFIELD }).map((h) => h.name)).toEqual(["Ridge Trail"])
			// The OLD 12-ring budget (covers gridDistance ≤ 11) does NOT — this is the exact boundary miss nm-04 exposed.
			expect(lk.search({ categoryID: "trail", center: SPRINGFIELD, maxRings: 12 })).toEqual([])
			// It first appears at maxRings 14 (disk radius 13) — the bare threshold the default clears with 2 rings of margin.
			expect(lk.search({ categoryID: "trail", center: SPRINGFIELD, maxRings: 13 })).toEqual([])
			expect(lk.search({ categoryID: "trail", center: SPRINGFIELD, maxRings: 14 }).map((h) => h.name)).toEqual([
				"Ridge Trail",
			])
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("categoryIDs fan-out unions rows across every resolved leaf, nearest-first", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			// `cafe` + `fast_food` near Springfield = the 3 cafes + McDonald's, unioned and distance-sorted.
			const hits = lk.search({ categoryIDs: ["cafe", "fast_food"], center: SPRINGFIELD, limit: 10 })
			expect(new Set(hits.map((h) => h.name))).toEqual(new Set(["Cafe Alpha", "Cafe Beta", "Cafe Gamma", "McDonald's"]))

			for (let i = 1; i < hits.length; i++) {
				expect(hits[i]!.distanceM).toBeGreaterThanOrEqual(hits[i - 1]!.distanceM!)
			}
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("categoryIDs skips leaves the dictionary doesn't carry, keeping the resolvable ones", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			const hits = lk.search({ categoryIDs: ["cafe", "zoo"], center: SPRINGFIELD, limit: 10 })
			expect(hits.map((h) => h.name)).toEqual(["Cafe Alpha", "Cafe Beta", "Cafe Gamma"])
		} finally {
			lk[Symbol.dispose]()
		}
	})

	test("categoryIDs with no resolvable leaf is a clean miss, not a throw", () => {
		const lk = new POILookup({ databasePath: dbPath })

		try {
			expect(lk.search({ categoryIDs: ["zoo", "aquarium"], center: SPRINGFIELD })).toEqual([])
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

	test("the brand_wikidata partial index exists (brand-wide fetch, not a full table scan)", () => {
		const raw = new DatabaseSync(dbPath, { readOnly: true })

		try {
			const found = raw
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
				.get("poi_brand_wikidata") as { sql: string } | undefined
			expect(found).toBeDefined()
			// PARTIAL: the DDL carries the `WHERE brand_wikidata IS NOT NULL` predicate.
			expect(found!.sql.toLowerCase()).toContain("where")
			expect(found!.sql.toLowerCase()).toContain("brand_wikidata")
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
