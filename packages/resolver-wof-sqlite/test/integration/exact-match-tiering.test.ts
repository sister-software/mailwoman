import type { RankingWeights } from "@mailwoman/resolver-wof-sqlite/lookup"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite/lookup"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, describe, expect, test } from "vitest"

interface SeedRegion {
	placetype?: string
	id: number
	name: string
	country: string
	lat: number
	lon: number
	population?: number
	aliases?: string[]
}

function buildDB(regions: SeedRegion[]): DatabaseClient<WOFDatabase> {
	const db = DatabaseClient.temp<WOFDatabase>()

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
	`)

	const insertSpr = db.prepare(`
		INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude,
			min_latitude, max_latitude, min_longitude, max_longitude, is_current, is_deprecated)
		VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, -1, 0)
	`)

	const insertName = db.prepare(`INSERT INTO names (id, language, name) VALUES (?, ?, ?)`)
	const insertPop = db.prepare(`INSERT INTO place_population (id, population) VALUES (?, ?)`)

	for (const r of regions) {
		insertSpr.run(
			r.id,
			r.name,
			r.placetype ?? "region",
			r.country,
			r.lat,
			r.lon,
			r.lat - 0.5,
			r.lat + 0.5,
			r.lon - 0.5,
			r.lon + 0.5
		)

		insertName.run(r.id, "eng", r.name)

		for (const a of r.aliases ?? []) {
			insertName.run(r.id, "abbr", a)
		}

		if (r.population !== undefined) {
			insertPop.run(r.id, r.population)
		}
	}

	return db
}

const REGIONS: SeedRegion[] = [
	{ id: 1, name: "Maine", country: "US", lat: 45.3, lon: -69.2, aliases: ["ME"] },
	{ id: 2, name: "ME Plains", country: "US", lat: 38.4, lon: -92.5, population: 6_196_156 },
]

const POP_DOMINATES: Partial<RankingWeights> = { populationBoost: 1000, populationScaleLog10: 6 }

let lookup: WOFSQLitePlaceLookup
afterEach(() => lookup[Symbol.dispose]())

describe("findPlace — exact-match tiering", () => {
	test("Exact alias match beats a population-dominated partial match (ME → Maine)", async () => {
		lookup = new WOFSQLitePlaceLookup({ database: buildDB(REGIONS), buildFTS: true }, POP_DOMINATES)
		const results = await lookup.findPlace({ text: "ME", placetype: "region", country: "US" })
		expect(results.length).toBeGreaterThan(1)
		expect(results[0]!.id).toBe(1)
		expect(results[0]!.name).toBe("Maine")
	})

	test("with tiering OFF + population dominating, the populous non-exact match wins (the bug)", async () => {
		lookup = new WOFSQLitePlaceLookup(
			{ database: buildDB(REGIONS), buildFTS: true },
			{ ...POP_DOMINATES, exactMatchTiering: false }
		)

		const results = await lookup.findPlace({ text: "ME", placetype: "region", country: "US" })
		expect(results[0]!.id).toBe(2)
	})

	test(": name-exact outranks alias-exact regardless of population", async () => {
		const db = buildDB([
			{ id: 11, name: "Capitalia", country: "FR", lat: 48.8, lon: 2.3, population: 50_000 },
			{
				id: 12,
				name: "Capitalia Township",
				country: "US",
				lat: 40.5,
				lon: -81.5,
				aliases: ["Capitalia"],
				population: 9_000_000,
			},
		])

		lookup = new WOFSQLitePlaceLookup({ database: db, buildFTS: true }, POP_DOMINATES)
		const results = await lookup.findPlace({ text: "Capitalia", placetype: "region", limit: 2 })

		expect(results[0]?.name).toBe("Capitalia")
		expect(results[1]?.name).toBe("Capitalia Township")

		expect(results[0]?.exactMatch).toBe(true)
		expect(results[1]?.exactMatch).toBe(true)
	})

	test("alignment: among EQUALLY-exact matches, population still decides (Springfield by pop)", async () => {
		lookup = new WOFSQLitePlaceLookup({
			database: buildDB([
				{ id: 10, name: "Springfield", country: "US", lat: 39.8, lon: -89.65, population: 112_544 },
				{ id: 11, name: "Springfield", country: "US", lat: 37.2, lon: -93.28, population: 171_589 },
			]),
			buildFTS: true,
		})

		const results = await lookup.findPlace({ text: "Springfield", placetype: "region", country: "US" })
		expect(results).toHaveLength(2)
		expect(results[0]!.id).toBe(11)
	})

	test("Short-query over-fetch rescues an exact-abbrev region below the normal window (NY → New York)", async () => {
		const decoys: SeedRegion[] = Array.from({ length: 60 }, (_, i) => ({
			id: 1000 + i,
			name: `Ny Province ${i}`,
			country: "GB",
			lat: 50 + i * 0.01,
			lon: -1 + i * 0.01,
		}))

		const newYork: SeedRegion = {
			id: 1,
			name: "New York",
			country: "US",
			lat: 43,
			lon: -75,

			aliases: ["NY", ...Array.from({ length: 40 }, (_, i) => `New York alternate label ${i}`)],
		}

		lookup = new WOFSQLitePlaceLookup({ database: buildDB([newYork, ...decoys]), buildFTS: true })
		const results = await lookup.findPlace({ text: "NY", placetype: "region", limit: 2 })
		expect(results[0]!.id).toBe(1)
		expect(results[0]!.name).toBe("New York")
	})

	test(": NL postcode ladder — joined form first, stem second, country-restricted", async () => {
		const db = buildDB([
			{ id: 21, name: "1012LG", country: "NL", lat: 52.377, lon: 4.898, placetype: "postalcode" },
			{ id: 22, name: "1012", country: "NL", lat: 52.374, lon: 4.895, placetype: "postalcode" },
		])

		lookup = new WOFSQLitePlaceLookup({ database: db, buildFTS: true })

		const nonPostcode = await lookup.findPlace({ text: "1012 LG", placetype: "region", country: "NL", limit: 1 })
		expect(nonPostcode).toHaveLength(0)

		const fullPc = await lookup.findPlace({ text: "1012 LG", placetype: "postalcode", country: "NL", limit: 1 })
		expect(fullPc[0]?.name).toBe("1012LG")

		const stem = await lookup.findPlace({ text: "1012 XX", placetype: "postalcode", country: "NL", limit: 1 })
		expect(stem[0]?.name).toBe("1012")

		const gb = await lookup.findPlace({ text: "1012 LG", placetype: "postalcode", country: "GB", limit: 1 })
		expect(gb).toHaveLength(0)
	})

	test("bias re-ranks a cross-country postcode tie; absent bias = population order", async () => {
		const db = buildDB([
			{ id: 31, name: "48026", country: "IT", lat: 44.37, lon: 12.03, placetype: "postalcode", population: 12_000 },
			{ id: 32, name: "48026", country: "US", lat: 42.54, lon: -82.95, placetype: "postalcode", population: 900 },
		])

		lookup = new WOFSQLitePlaceLookup({ database: db, buildFTS: true })

		const noBias = await lookup.findPlace({ text: "48026", placetype: "postalcode", limit: 2 })
		expect(noBias[0]?.country).toBe("IT")

		const usBias = await lookup.findPlace({
			text: "48026",
			placetype: "postalcode",
			limit: 2,
			bias: [{ lat: 42.33, lon: -83.05 }],
		})

		expect(usBias[0]?.country).toBe("US")
		expect(usBias).toHaveLength(2)

		const itBias = await lookup.findPlace({
			text: "48026",
			placetype: "postalcode",
			limit: 2,
			bias: [{ lat: 44.42, lon: 12.2 }],
		})

		expect(itBias[0]?.country).toBe("IT")
	})

	test("a single candidate is unaffected (no tier to split)", async () => {
		lookup = new WOFSQLitePlaceLookup({
			database: buildDB([
				{ id: 1, name: "Oregon", country: "US", lat: 43.9, lon: -120.6, population: 4_233_358, aliases: ["OR"] },
			]),
			buildFTS: true,
		})

		const results = await lookup.findPlace({ text: "OR", placetype: "region", country: "US" })
		expect(results).toHaveLength(1)
		expect(results[0]!.name).toBe("Oregon")
	})

	test("candidates carry the spr bbox (WASM-lookup parity — the demo cascade's region constraint reads it)", async () => {
		lookup = new WOFSQLitePlaceLookup({ database: buildDB(REGIONS), buildFTS: true })
		const results = await lookup.findPlace({ text: "Maine", placetype: "region", country: "US" })
		expect(results[0]!.name).toBe("Maine")
		expect(results[0]!.bbox).toEqual({ minLat: 44.8, maxLat: 45.8, minLon: -69.7, maxLon: -68.7 })
	})
})
