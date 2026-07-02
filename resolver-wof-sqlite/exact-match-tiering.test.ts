/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for exact-match tiering in `WOFSqlitePlaceLookup.findPlace` — the ranking fix that keeps
 *   the population/importance prior as an INTRA-tier tiebreaker instead of letting it promote a
 *   worse-matching candidate across tiers.
 *
 *   The motivating bug: querying the 2-letter region abbreviation "ME" returned Maine (which has the
 *   exact alias `ME`) AND larger-population states that also surfaced as FTS candidates; the
 *   additive population boost overcame Maine's text-match edge, so "Portland, ME" resolved its
 *   region to a more-populous wrong state and the locality cascaded with it. Tiering puts exact
 *   name/alias matches in a higher tier; population only orders WITHIN a tier.
 *
 *   The population-override is forced deterministically here (large `populationBoost` + a decoy state
 *   with population while Maine has NONE) rather than relying on the small in-memory fixture's BM25
 *   balance happening to mirror the 1.8 GB production DB — where Maine's hundreds of alt-name rows
 *   dilute its FTS doc score (the real-world trigger). This isolates the TIERING logic.
 */

import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, test } from "vitest"

import type { RankingWeights } from "./lookup.js"
import { WOFSqlitePlaceLookup } from "./lookup.js"

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

/**
 * Build a fixture in the production shape: a pre-built `place_population` aux table (no geojson — `build-unified-wof`
 * extracts `wof:population` into this table at ingest), so the population boost is actually active (the plain
 * lookup.test.ts seed has no population path). Opened with `buildFTS: true` by the lookup; the lazy FTS build leaves
 * the pre-existing `place_population` untouched (it only (re)builds it from geojson, which we don't carry).
 */
function buildDB(regions: SeedRegion[]): DatabaseSync {
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

		for (const a of r.aliases ?? []) insertName.run(r.id, "abbr", a)

		if (r.population !== undefined) insertPop.run(r.id, r.population)
	}

	return db
}

// Maine (exact alias "ME", NO population) vs a populous state whose name token also matches "ME" but
// is NOT an exact match. "ME Plains" stands in for the real states that surfaced as non-exact "ME"
// candidates. Maine has no population so the boost asymmetry is unambiguous: with a large
// `populationBoost`, ME-Plains gets a big lift and Maine gets +0 — so WITHOUT tiering the populous
// non-match strictly outranks the exact match (the bug), and WITH tiering the exact match wins
// regardless (the fix).
const REGIONS: SeedRegion[] = [
	{ id: 1, name: "Maine", country: "US", lat: 45.3, lon: -69.2, aliases: ["ME"] },
	{ id: 2, name: "ME Plains", country: "US", lat: 38.4, lon: -92.5, population: 6_196_156 },
]

// Large boost magnitude so the populous decoy's lift dwarfs any BM25 gap; Maine (no population) gets
// +0. Makes the OFF case reliably pick the populous non-match.
const POP_DOMINATES: Partial<RankingWeights> = { populationBoost: 1000, populationScaleLog10: 6 }

let lookup: WOFSqlitePlaceLookup
afterEach(() => lookup?.close())

describe("findPlace — exact-match tiering", () => {
	test("exact alias match beats a population-dominated partial match (ME → Maine)", async () => {
		lookup = new WOFSqlitePlaceLookup({ database: buildDB(REGIONS), buildFTS: true }, POP_DOMINATES)
		const results = await lookup.findPlace({ text: "ME", placetype: "region", country: "US" })
		expect(results.length).toBeGreaterThan(1) // both surface as candidates
		expect(results[0]!.id).toBe(1) // Maine wins despite zero population vs the 6M decoy
		expect(results[0]!.name).toBe("Maine")
	})

	test("with tiering OFF + population dominating, the populous non-exact match wins (the bug)", async () => {
		lookup = new WOFSqlitePlaceLookup(
			{ database: buildDB(REGIONS), buildFTS: true },
			{ ...POP_DOMINATES, exactMatchTiering: false }
		)
		const results = await lookup.findPlace({ text: "ME", placetype: "region", country: "US" })
		expect(results[0]!.id).toBe(2) // the populous non-exact match — pre-fix behavior
	})

	// #912 sub-tier: the query IS one place's own name and only an ALIAS of the other. The name
	// holder must win even when the alias holder is more populous — 'Paris' (the capital's own name)
	// over 'Paris Township' (alias 'Paris'), scale-model edition. ME→Maine (alias-exact, no
	// name-exact competitor) is covered by the tests above and must keep passing unchanged.
	test("#912: name-exact outranks alias-exact regardless of population", async () => {
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
		lookup = new WOFSqlitePlaceLookup({ database: db, buildFTS: true }, POP_DOMINATES)
		const results = await lookup.findPlace({ text: "Capitalia", placetype: "region", limit: 2 })

		expect(results[0]?.name).toBe("Capitalia")
		expect(results[1]?.name).toBe("Capitalia Township")
		// Both still stamp exactMatch — the sub-tier reorders WITHIN the tier, not across the flag.
		expect(results[0]?.exactMatch).toBe(true)
		expect(results[1]?.exactMatch).toBe(true)
	})

	test("alignment: among EQUALLY-exact matches, population still decides (Springfield by pop)", async () => {
		// Both exact name matches → same tier → the population prior orders them, unchanged. This is
		// the guarantee that tiering aligns with (rather than overrides) population/importance.
		lookup = new WOFSqlitePlaceLookup({
			database: buildDB([
				{ id: 10, name: "Springfield", country: "US", lat: 39.8, lon: -89.65, population: 112_544 },
				{ id: 11, name: "Springfield", country: "US", lat: 37.2, lon: -93.28, population: 171_589 },
			]),
			buildFTS: true,
		})
		const results = await lookup.findPlace({ text: "Springfield", placetype: "region", country: "US" })
		expect(results.length).toBe(2)
		expect(results[0]!.id).toBe(11) // higher population wins within the exact tier
	})

	test("short-query over-fetch rescues an exact-abbrev region below the normal window (NY → New York)", async () => {
		// The window-drop class (distinct from the population-override above). An exact-abbrev holder
		// ("NY" → New York) whose BM25 for the bare 2-letter token is poor — its long multilingual
		// alt-name document dilutes the score — sinks BELOW the normal `limit * 4` over-fetch window,
		// behind a crowd of regions that merely TOKEN-match "ny". Without widening the window for short
		// queries it never enters the candidate pool, so exact-match tiering can't promote it and a
		// token-matching decoy wins (the real-DB "NY → Highland, GB" bug). With the widening, New York
		// is in the pool and tiering lifts it. No `country` hint — this is the bare, no-context path.
		const decoys: SeedRegion[] = Array.from({ length: 60 }, (_, i) => ({
			id: 1000 + i,
			name: `Ny Province ${i}`, // tokenizes to include "ny" → matches MATCH 'ny'; short doc → good BM25
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
			// Exact alias "NY" + a long alt-name doc → poor BM25 for "ny" → sorts below all 60 decoys
			// (rank ~61: outside the default `limit * 4` window, inside the 200 short-query floor).
			aliases: ["NY", ...Array.from({ length: 40 }, (_, i) => `New York alternate label ${i}`)],
		}
		lookup = new WOFSqlitePlaceLookup({ database: buildDB([newYork, ...decoys]), buildFTS: true })
		const results = await lookup.findPlace({ text: "NY", placetype: "region", limit: 2 })
		expect(results[0]!.id).toBe(1)
		expect(results[0]!.name).toBe("New York")
	})

	// #924: the NL retry ladder — spaced full-form queries reach unspaced full-code rows (block
	// level), and unknown letter pairs fall to the 4-digit stem. Country-gated: the same shape
	// under another country must NOT retry.
	test("#924: NL postcode ladder — joined form first, stem second, country-gated", async () => {
		const db = buildDB([
			{ id: 21, name: "1012LG", country: "NL", lat: 52.377, lon: 4.898, placetype: "postalcode" },
			{ id: 22, name: "1012", country: "NL", lat: 52.374, lon: 4.895, placetype: "postalcode" },
		])
		lookup = new WOFSqlitePlaceLookup({ database: db, buildFTS: true })

		// Placetype gate: a region-typed query never enters the ladder (and the spaced phrase can't
		// FTS-match the one-token docs), so it comes back empty rather than silently coarsening.
		const nonPostcode = await lookup.findPlace({ text: "1012 LG", placetype: "region", country: "NL", limit: 1 })
		expect(nonPostcode).toHaveLength(0)

		const fullPc = await lookup.findPlace({ text: "1012 LG", placetype: "postalcode", country: "NL", limit: 1 })
		expect(fullPc[0]?.name).toBe("1012LG")

		const stem = await lookup.findPlace({ text: "1012 XX", placetype: "postalcode", country: "NL", limit: 1 })
		expect(stem[0]?.name).toBe("1012")

		const gb = await lookup.findPlace({ text: "1012 LG", placetype: "postalcode", country: "GB", limit: 1 })
		expect(gb).toHaveLength(0)
	})

	test("a single candidate is unaffected (no tier to split)", async () => {
		lookup = new WOFSqlitePlaceLookup({
			database: buildDB([
				{ id: 1, name: "Oregon", country: "US", lat: 43.9, lon: -120.6, population: 4_233_358, aliases: ["OR"] },
			]),
			buildFTS: true,
		})
		const results = await lookup.findPlace({ text: "OR", placetype: "region", country: "US" })
		expect(results.length).toBe(1)
		expect(results[0]!.name).toBe("Oregon")
	})

	test("candidates carry the spr bbox (WASM-lookup parity — the demo cascade's region constraint reads it)", async () => {
		// Without candidate.bbox the cascade's region→bbox constraint is dead on the Node backend and
		// locality disambiguation falls to population ranking (Springfield IL → MO, caught by the
		// #524 smoke eval). The fixture seeds min/max as centroid ±0.5.
		lookup = new WOFSqlitePlaceLookup({ database: buildDB(REGIONS), buildFTS: true })
		const results = await lookup.findPlace({ text: "Maine", placetype: "region", country: "US" })
		expect(results[0]!.name).toBe("Maine")
		expect(results[0]!.bbox).toEqual({ minLat: 44.8, maxLat: 45.8, minLon: -69.7, maxLon: -68.7 })
	})
})
