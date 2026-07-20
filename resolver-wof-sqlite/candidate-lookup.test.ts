/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link WOFCandidateTableLookup} — the Node {@link PlaceLookup} over the byte-range
 *   candidate.db (the SAME backend + ranking the browser demo uses). Builds a tiny fixture admin
 *   WOF with a HOMONYM (Moscow RU vs Moscow ID) + a postcode shard via the real
 *   {@link buildCandidateTable}, then asserts the resolver disciplines the CLI/server depend on:
 *
 *   - **population-first, country-agnostic** ranking — bare "Moscow" → the 10.4 M-pop Russian city, not
 *       the 26 k-pop Idaho town (the divergence from FTS bm25 this backend exists to fix);
 *   - Country / placetype / bbox filters + the alias rows + the qualifier-strip fallback;
 *   - The {@link PlaceCandidate} shape (score = −neg_rank, exactMatch, bbox);
 *   - Postcode rows resolve, and placeholder 0,0-coord rows were dropped at build.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildCandidateTable } from "./build-candidate.ts"
import { WOFCandidateTableLookup } from "./candidate-lookup.ts"

const ALIAS_SEP = "\u{E000}"

let scratch: string
let candidatePath: string

/**
 * Minimal admin WOF (the tables `buildCandidateTable` reads) with a population homonym + alias + qualifier case.
 */
function buildFixtureAdmin(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE place_search (wof_id INTEGER PRIMARY KEY, alt_names TEXT);
		CREATE TABLE place_abbr (id INTEGER PRIMARY KEY, abbr TEXT);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);

		-- The homonym: Moscow RU (megacity) vs Moscow, Idaho (small US town).
		INSERT INTO spr VALUES (300, 'Moscow', 'locality', 'RU', 55.75, 37.62, 55.5, 37.3, 56.0, 37.9, -1, 0);
		INSERT INTO spr VALUES (301, 'Moscow', 'locality', 'US', 46.73, -117.00, 46.6, -117.2, 46.8, -116.8, -1, 0);
		INSERT INTO spr VALUES (200, 'Chicago', 'locality', 'US', 41.88, -87.63, 41.6, -87.9, 42.0, -87.5, -1, 0);
		-- Qualifier case: the gazetteer name is bare "Lenk"; the query "Lenk im Simmental" strips to it.
		INSERT INTO spr VALUES (302, 'Lenk', 'locality', 'CH', 46.46, 7.44, 46.4, 7.4, 46.5, 7.5, -1, 0);
		-- Region-scope case (parentID → region_id): two same-name US localities under DIFFERENT regions.
		-- Springfield, MO is the more populous, so population-first (no parentID) picks it; Springfield, IL
		-- is the in-region answer when the walk passes parentID = Illinois (400).
		INSERT INTO spr VALUES (400, 'Illinois', 'region', 'US', 40.0, -89.0, 37.0, -91.5, 42.5, -87.0, -1, 0);
		INSERT INTO spr VALUES (401, 'Missouri', 'region', 'US', 38.3, -92.4, 36.0, -95.8, 40.6, -89.1, -1, 0);
		INSERT INTO spr VALUES (310, 'Springfield', 'locality', 'US', 39.78, -89.65, 39.7, -89.75, 39.85, -89.55, -1, 0);
		INSERT INTO spr VALUES (311, 'Springfield', 'locality', 'US', 37.19, -93.29, 37.1, -93.4, 37.3, -93.2, -1, 0);

		INSERT INTO place_population VALUES (300, 10400000);
		INSERT INTO place_population VALUES (301, 26000);
		INSERT INTO place_population VALUES (200, 2700000);
		INSERT INTO place_population VALUES (302, 2400);
		INSERT INTO place_population VALUES (310, 114000);
		INSERT INTO place_population VALUES (311, 169000);

		-- Region ancestry: build-candidate reads WHERE ancestor_placetype='region' to stamp region_id.
		INSERT INTO ancestors VALUES (310, 400, 'region');
		INSERT INTO ancestors VALUES (311, 401, 'region');

		-- Alias bag: the Russian city's transliteration, so "Moskva" resolves to it.
		INSERT INTO place_search VALUES (300, 'Moskva${ALIAS_SEP}Moscow City');
	`)
	db.close()
}

/**
 * A postcode shard: one real-coord ZIP + one placeholder 0,0 (dropped at build, the White House 20500 case).
 */
function buildFixturePostcodes(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		INSERT INTO spr VALUES (60601, '60601', 'postalcode', 'US', 41.885, -87.62, 41.88, -87.63, 41.89, -87.61, -1, 0);
		INSERT INTO spr VALUES (20500, '20500', 'postalcode', 'US', 0, 0, 0, 0, 0, 0, -1, 0);
	`)
	db.close()
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-candidate-lookup-"))
	const input = join(scratch, "admin.db")
	const pc = join(scratch, "postcodes.db")
	candidatePath = join(scratch, "candidate.db")
	buildFixtureAdmin(input)
	buildFixturePostcodes(pc)
	await buildCandidateTable({ input, output: candidatePath, postcodes: [pc] })
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("WOFCandidateTableLookup", () => {
	test("ranks homonyms population-first + country-agnostic (Moscow → RU, not Idaho)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Moscow", placetype: "locality", limit: 5 })
			expect(hits).toHaveLength(2)
			// The 10.4M-pop Russian city outranks the 26k-pop Idaho town — no country filter needed.
			expect(hits[0]!.country).toBe("RU")
			expect(hits[0]!.lat).toBeCloseTo(55.75, 2)
			expect(hits[1]!.country).toBe("US")
			// score = -neg_rank → the higher-population hit ranks at least as high.
			expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score)
		} finally {
			lk.close()
		}
	})

	test("proximity bias (#938) re-ranks the exact tier by nearness without a hard filter", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// No bias: population wins — Moscow, RU (10.4M) over Moscow, ID (26k).
			const plain = await lk.findPlace({ text: "Moscow", placetype: "locality", limit: 5 })
			expect(plain[0]!.country).toBe("RU")

			// A view over Idaho flips it to Moscow, ID — the in-view namesake wins the tie.
			const idahoView = await lk.findPlace({
				text: "Moscow",
				placetype: "locality",
				limit: 5,
				bias: [{ lat: 46.73, lon: -117.0, weight: 1 }],
			})
			expect(idahoView[0]!.country).toBe("US")
			expect(idahoView[0]!.lat).toBeCloseTo(46.73, 1)

			// A DISTANT view must NOT flip a far-more-populous city: a Chicago-area view (near neither
			// Moscow) leaves population-first order intact — the sharp decay keeps out-of-view namesakes out.
			const chicagoView = await lk.findPlace({
				text: "Moscow",
				placetype: "locality",
				limit: 5,
				bias: [{ lat: 41.88, lon: -87.63, weight: 1 }],
			})
			expect(chicagoView[0]!.country).toBe("RU")
		} finally {
			lk.close()
		}
	})

	test("country filter narrows to the requested country", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Moscow", placetype: "locality", country: "US" })
			expect(hits).toHaveLength(1)
			expect(hits[0]!.country).toBe("US")
			expect(hits[0]!.lat).toBeCloseTo(46.73, 2)
		} finally {
			lk.close()
		}
	})

	test("an unknown country (not in the table) returns no candidates", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			expect(await lk.findPlace({ text: "Moscow", placetype: "locality", country: "ZZ" })).toHaveLength(0)
		} finally {
			lk.close()
		}
	})

	test("resolves an alias row to the primary place", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const [hit] = await lk.findPlace({ text: "Moskva", placetype: "locality" })
			expect(hit?.name).toBe("Moscow")
			expect(hit?.country).toBe("RU")
			expect(hit?.exactMatch).toBe(true) // every candidate row IS an exact normalized-name/alias match
		} finally {
			lk.close()
		}
	})

	test("returns the denormalized PlaceCandidate shape (exactMatch + bbox + coords)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const [chi] = await lk.findPlace({ text: "Chicago", placetype: "locality" })
			expect(chi).toMatchObject({ name: "Chicago", placetype: "locality", country: "US", exactMatch: true })
			expect(chi!.lat).toBeCloseTo(41.88, 2)
			expect(chi!.bbox?.minLat).toBeCloseTo(41.6, 2)
			expect(chi!.bbox?.maxLon).toBeCloseTo(-87.5, 2)
		} finally {
			lk.close()
		}
	})

	test("bbox filter keeps only candidates whose centroid falls inside (the region-disambiguation path)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// A box over European Russia — contains RU Moscow's centroid, not the Idaho one.
			const hits = await lk.findPlace({
				text: "Moscow",
				placetype: "locality",
				bbox: { minLat: 50, maxLat: 60, minLon: 30, maxLon: 45 },
			})
			expect(hits).toHaveLength(1)
			expect(hits[0]!.country).toBe("RU")
		} finally {
			lk.close()
		}
	})

	test("qualifier-strip fallback resolves 'Lenk im Simmental' → 'Lenk'", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const [hit] = await lk.findPlace({ text: "Lenk im Simmental", placetype: "locality" })
			expect(hit?.name).toBe("Lenk")
			expect(hit?.country).toBe("CH")
		} finally {
			lk.close()
		}
	})

	test("folds postcodes in; resolves a real ZIP, drops the placeholder 0,0 row", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const [zip] = await lk.findPlace({ text: "60601", placetype: "postalcode" })
			expect(zip?.placetype).toBe("postalcode")
			expect(zip?.lat).toBeCloseTo(41.885, 3)
			// 20500's 0,0 placeholder was filtered at build time.
			expect(await lk.findPlace({ text: "20500", placetype: "postalcode" })).toHaveLength(0)
		} finally {
			lk.close()
		}
	})

	test("a placetype that doesn't match the row's type yields nothing (Moscow is not a postalcode)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			expect(await lk.findPlace({ text: "Moscow", placetype: "postalcode" })).toHaveLength(0)
		} finally {
			lk.close()
		}
	})

	test("an unknown name + an empty query return no candidates", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			expect(await lk.findPlace({ text: "Nowhereville" })).toHaveLength(0)
			expect(await lk.findPlace({ text: "   " })).toHaveLength(0)
		} finally {
			lk.close()
		}
	})

	test("FTS5-trigram fuzzy fallback recovers a misspelled locality on an exact miss", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// "Chicgo"/"Moscw" aren't a name_key — the exact + strip probes miss, so the trigram fallback
			// recovers the right place by name similarity, still country/placetype-filtered and ranked like
			// the admin backend. (The fixture's buildCandidateTable now materializes the candidate_fts index.)
			expect((await lk.findPlace({ text: "Chicgo", placetype: "locality", country: "US" }))[0]?.name).toBe("Chicago")
			expect((await lk.findPlace({ text: "Moscw", placetype: "locality", country: "RU" }))[0]?.name).toBe("Moscow")
			// Garbage stays a miss — the trigram-Jaccard threshold filters noise (no false fuzzy hit).
			expect(await lk.findPlace({ text: "Zzzqqx", placetype: "locality", country: "US" })).toHaveLength(0)
		} finally {
			lk.close()
		}
	})

	test("parentID scopes the probe to the in-region place (Springfield → IL under Illinois, not the larger MO)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// Baseline: no parentID → population-first picks the larger Springfield, MO (169k > 114k).
			const bare = await lk.findPlace({ text: "Springfield", placetype: "locality", country: "US", limit: 5 })
			expect(bare.map((c) => c.id)).toContain(310)
			expect(bare.map((c) => c.id)).toContain(311)
			expect(bare[0]!.id).toBe(311) // MO first, by population
			expect(bare[0]!.lat).toBeCloseTo(37.19, 2)

			// With parentID = Illinois (400), region_id scoping returns ONLY Springfield, IL (310) —
			// the population-first MO pick is dropped because it isn't in the parent region.
			const scoped = await lk.findPlace({
				text: "Springfield",
				placetype: "locality",
				country: "US",
				parentID: 400,
				limit: 5,
			})
			expect(scoped).toHaveLength(1)
			expect(scoped[0]!.id).toBe(310)
			expect(scoped[0]!.lat).toBeCloseTo(39.78, 2)
		} finally {
			lk.close()
		}
	})

	test("parentID falls back to the unscoped probe when the region has no in-region match", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// parentID = 999 is a region NO Springfield sits under → the region-scoped cascade returns
			// nothing, so the reader retries unscoped and resolves exactly as the bare query does today
			// (population-first Springfield, MO). Fallback is recall-safe: a wrong/absent parent never
			// drops a place that a plain lookup would have found.
			const scoped = await lk.findPlace({
				text: "Springfield",
				placetype: "locality",
				country: "US",
				parentID: 999,
				limit: 5,
			})
			expect(scoped.length).toBeGreaterThan(0)
			expect(scoped[0]!.id).toBe(311) // unscoped population-first — same as the no-parentID baseline
			expect(scoped[0]!.lat).toBeCloseTo(37.19, 2)
		} finally {
			lk.close()
		}
	})
})
