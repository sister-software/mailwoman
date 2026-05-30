/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for exact-match tiering in `WofSqlitePlaceLookup.findPlace` — the ranking fix that keeps
 *   the population/importance prior as an INTRA-tier tiebreaker instead of letting it promote a
 *   worse-matching candidate across tiers.
 *
 *   The motivating bug: querying the 2-letter region abbreviation "ME" returned Maine (which has the
 *   exact alias `ME`) AND larger-population states that also surfaced as candidates; the additive
 *   population boost (up to +4) overcame Maine's text-match edge, so "Portland, ME" resolved its
 *   region to a more-populous wrong state and the locality cascaded with it. Tiering puts exact
 *   name/alias matches in a higher tier; population only orders WITHIN a tier.
 */

import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, test } from "vitest"

import { buildPlaceSearchFts } from "./fts.js"
import { WofSqlitePlaceLookup } from "./lookup.js"

interface SeedRegion {
	id: number
	name: string
	country: string
	lat: number
	lon: number
	population?: number
	aliases?: string[]
}

/**
 * Build a fixture with the geojson body that `buildPlaceSearchFts` reads to populate the
 * `place_population` aux table — so the population boost is actually active (the plain lookup.test.ts
 * seed has no population path).
 */
function buildDb(regions: SeedRegion[]): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		CREATE TABLE geojson (id INTEGER PRIMARY KEY, body TEXT);
	`)
	const insertSpr = db.prepare(`
		INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude,
			min_latitude, max_latitude, min_longitude, max_longitude, is_current, is_deprecated)
		VALUES (?, NULL, ?, 'region', ?, ?, ?, ?, ?, ?, ?, -1, 0)
	`)
	const insertName = db.prepare(`INSERT INTO names (id, language, name) VALUES (?, ?, ?)`)
	const insertGeo = db.prepare(`INSERT INTO geojson (id, body) VALUES (?, ?)`)
	for (const r of regions) {
		insertSpr.run(r.id, r.name, r.country, r.lat, r.lon, r.lat - 0.5, r.lat + 0.5, r.lon - 0.5, r.lon + 0.5)
		insertName.run(r.id, "eng", r.name)
		for (const a of r.aliases ?? []) insertName.run(r.id, "abbr", a)
		const properties: Record<string, unknown> = { "geom:latitude": r.lat, "geom:longitude": r.lon }
		if (r.population !== undefined) properties["wof:population"] = r.population
		insertGeo.run(r.id, JSON.stringify({ properties }))
	}
	return db
}

// Maine (alias "ME", small pop) vs a much-more-populous state whose name token also matches the
// query "ME" but is NOT an exact match. Without tiering the populous state wins (the bug); with
// tiering Maine wins (exact alias). "ME Plains" stands in for the real-data states that surfaced as
// non-exact "ME" candidates — the point is a token match with a far larger population.
const REGIONS: SeedRegion[] = [
	{ id: 1, name: "Maine", country: "US", lat: 45.3, lon: -69.2, population: 1_395_722, aliases: ["ME"] },
	{ id: 2, name: "ME Plains", country: "US", lat: 38.4, lon: -92.5, population: 6_196_156 },
]

let lookup: WofSqlitePlaceLookup
afterEach(() => lookup?.close())

describe("findPlace — exact-match tiering", () => {
	test("exact alias match beats a higher-population partial match (ME → Maine, not the populous one)", async () => {
		lookup = new WofSqlitePlaceLookup({ database: buildDb(REGIONS), buildFts: true })
		const results = await lookup.findPlace({ text: "ME", placetype: "region", country: "US" })
		expect(results.length).toBeGreaterThan(1) // both surface as candidates
		expect(results[0]!.id).toBe(1) // Maine wins despite lower population
		expect(results[0]!.name).toBe("Maine")
	})

	test("with exactMatchTiering OFF, the higher-population partial match wins (documents the bug)", async () => {
		lookup = new WofSqlitePlaceLookup({ database: buildDb(REGIONS), buildFts: true }, { exactMatchTiering: false })
		const results = await lookup.findPlace({ text: "ME", placetype: "region", country: "US" })
		expect(results[0]!.id).toBe(2) // the populous non-exact match — the pre-fix behavior
	})

	test("alignment: among EQUALLY-exact matches, population still decides (Springfield IL vs MA)", async () => {
		// Both are exact name matches → same tier → the population prior orders them, unchanged. This
		// is the guarantee that tiering aligns with (rather than overrides) population/importance.
		lookup = new WofSqlitePlaceLookup({
			database: buildDb([
				{ id: 10, name: "Springfield", country: "US", lat: 39.8, lon: -89.65, population: 112_544 },
				{ id: 11, name: "Springfield", country: "US", lat: 37.2, lon: -93.28, population: 171_589 },
			]),
			buildFts: true,
		})
		const results = await lookup.findPlace({ text: "Springfield", placetype: "region", country: "US" })
		expect(results.length).toBe(2)
		expect(results[0]!.id).toBe(11) // higher population wins within the exact tier
	})

	test("a single candidate is unaffected (no tier to split)", async () => {
		lookup = new WofSqlitePlaceLookup({
			database: buildDb([{ id: 1, name: "Oregon", country: "US", lat: 43.9, lon: -120.6, population: 4_233_358, aliases: ["OR"] }]),
			buildFts: true,
		})
		const results = await lookup.findPlace({ text: "OR", placetype: "region", country: "US" })
		expect(results.length).toBe(1)
		expect(results[0]!.name).toBe("Oregon")
	})

	test("postcode-style shard with no `names` table → tiering no-ops, no crash", async () => {
		// Build a DB, FTS it, then drop `names` to simulate a shard the exact-match probe can't read.
		const db = buildDb(REGIONS)
		buildPlaceSearchFts(db)
		db.exec("DROP TABLE names")
		lookup = new WofSqlitePlaceLookup({ database: db })
		const results = await lookup.findPlace({ text: "ME", placetype: "region", country: "US" })
		// Falls back to weighted-sum order (population wins) — but must not throw.
		expect(results.length).toBeGreaterThan(0)
	})
})
