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
import { rankByPrimaryPreference, WOFCandidateTableLookup } from "./candidate-lookup.ts"

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

		-- Cross-country COLLISION (the Cancún/Changchun class): "Zedton" is a MX primary (0.89 M); a more-populous
		-- foreign place "Farland" CN (4.19 M) carries an exonym alias that normalizes to the SAME key "zedton".
		-- The population gap (0.67 log10) is under the 1.0 preference margin → the primary must win and the alias
		-- is demoted out of the exact tier (so a country posterior can't cross back).
		INSERT INTO spr VALUES (600, 'Zedton', 'locality', 'MX', 21.15, -86.84, 21.0, -87.0, 21.3, -86.7, -1, 0);
		INSERT INTO spr VALUES (601, 'Farland', 'locality', 'CN', 43.86, 125.28, 43.6, 125.0, 44.1, 125.6, -1, 0);
		-- DOMINANT alt-name (the LA/Los Angeles class): "Wyeburg" is a tiny GH primary (98 k); a huge foreign
		-- place "Wyemetro" US (3.8 M) is aliased to "wyeburg". Gap 1.6 log10 > 1.0 margin → the alias still wins
		-- and stays in the exact tier.
		INSERT INTO spr VALUES (602, 'Wyeburg', 'locality', 'GH', 5.55, -0.2, 5.5, -0.3, 5.6, -0.1, -1, 0);
		INSERT INTO spr VALUES (603, 'Wyemetro', 'locality', 'US', 34.05, -118.24, 33.9, -118.5, 34.2, -118.0, -1, 0);

		INSERT INTO place_population VALUES (300, 10400000);
		INSERT INTO place_population VALUES (301, 26000);
		INSERT INTO place_population VALUES (200, 2700000);
		INSERT INTO place_population VALUES (302, 2400);
		INSERT INTO place_population VALUES (310, 114000);
		INSERT INTO place_population VALUES (311, 169000);
		INSERT INTO place_population VALUES (600, 888797);
		INSERT INTO place_population VALUES (601, 4193073);
		INSERT INTO place_population VALUES (602, 98000);
		INSERT INTO place_population VALUES (603, 3800000);

		-- Region ancestry: build-candidate reads WHERE ancestor_placetype='region' to stamp region_id.
		INSERT INTO ancestors VALUES (310, 400, 'region');
		INSERT INTO ancestors VALUES (311, 401, 'region');

		-- Alias bag: the Russian city's transliteration, so "Moskva" resolves to it.
		INSERT INTO place_search VALUES (300, 'Moskva${ALIAS_SEP}Moscow City');
		-- The colliding exonym: Farland CN carries an alt-name that normalizes to "zedton" (the Çançun→cancun class).
		INSERT INTO place_search VALUES (601, 'Zedton');
		-- The dominant alt-name: Wyemetro US is aliased to "Wyeburg" (the LA→Los Angeles class).
		INSERT INTO place_search VALUES (603, 'Wyeburg');
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

	test("bounded primary preference: a same-key foreign primary beats a more-populous colliding alias (Cancún/Changchun)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// "Zedton" MX (0.89 M primary) vs the exonym alias of "Farland" CN (4.19 M, 0.67 log10 more populous).
			// Population-first alone would pick the foreign alias; the bounded preference keeps the primary.
			const hits = await lk.findPlace({ text: "Zedton", placetype: "locality", limit: 5 })
			expect(hits[0]!.name).toBe("Zedton")
			expect(hits[0]!.country).toBe("MX")
			expect(hits[0]!.exactMatch).toBe(true)
			// The colliding foreign alias is demoted OUT of the exact tier (so a country posterior can't cross back).
			const alias = hits.find((h) => h.country === "CN")
			expect(alias).toBeDefined()
			expect(alias!.exactMatch).toBe(false)
			// `score` stays the RAW population rank (for the walk's minWinningScore gate); `prominence` carries the
			// penalty, so the primary's prominence now exceeds the more-populous alias's.
			expect(hits[0]!.score).toBeLessThan(alias!.score)
			expect(hits[0]!.prominence!).toBeGreaterThan(alias!.prominence!)
		} finally {
			lk.close()
		}
	})

	test("bounded primary preference: a dominant alt-name still wins over an obscure same-key foreign primary (LA/Los Angeles)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// "Wyeburg" GH (98 k primary) vs the alias of "Wyemetro" US (3.8 M, 1.6 log10 more populous — over the
			// 1.0 margin). The dominant alias must still win AND stay in the exact tier (recall of real alt-names).
			const hits = await lk.findPlace({ text: "Wyeburg", placetype: "locality", limit: 5 })
			expect(hits[0]!.name).toBe("Wyemetro")
			expect(hits[0]!.country).toBe("US")
			expect(hits[0]!.exactMatch).toBe(true)
		} finally {
			lk.close()
		}
	})
})

describe("rankByPrimaryPreference (bounded cross-country primary preference)", () => {
	// Synthetic rows (population-ordered, neg_rank ASC) — the pure re-rank contract, no DB.
	const row = (neg_rank: number, is_primary: number, country_id: number) => ({ neg_rank, is_primary, country_id })

	test("a colliding foreign alias within the margin loses to the primary and is demoted", () => {
		// primary MX (neg -5.95) vs foreign alias CN (neg -6.62 — more populous, gap 0.67 < 1.0 margin).
		const ranked = rankByPrimaryPreference([row(-6.62, 0, 2), row(-5.95, 1, 1)], 5)
		expect(ranked[0]!.is_primary).toBe(1) // primary first
		expect(ranked[0]!.country_id).toBe(1)
		expect(ranked[0]!.demoted).toBe(false)
		const alias = ranked.find((r) => r.country_id === 2)!
		expect(alias.demoted).toBe(true) // the losing foreign alias is demoted out of the exact tier
		expect(alias.effectiveNegRank).toBeCloseTo(-5.62, 5) // -6.62 + 1.0 penalty
	})

	test("a dominant foreign alias over the margin still wins and is NOT demoted", () => {
		// primary GH (neg -4.99) vs foreign alias US (neg -6.58 — gap 1.59 > 1.0 margin).
		const ranked = rankByPrimaryPreference([row(-6.58, 0, 1), row(-4.99, 1, 3)], 5)
		expect(ranked[0]!.is_primary).toBe(0) // the dominant alias wins
		expect(ranked[0]!.country_id).toBe(1)
		expect(ranked[0]!.demoted).toBe(false) // stays exact — real alt-name recall preserved
	})

	test("a same-country alias is never penalized (population decides — Frisco → San Francisco)", () => {
		// primary US small (neg -5.34) vs alias US big (neg -5.91) — SAME country, so pure population.
		const ranked = rankByPrimaryPreference([row(-5.91, 0, 1), row(-5.34, 1, 1)], 5)
		expect(ranked[0]!.is_primary).toBe(0) // the bigger same-country alias wins
		expect(ranked[0]!.demoted).toBe(false)
		expect(ranked[0]!.effectiveNegRank).toBeCloseTo(-5.91, 5) // no penalty applied
	})

	test("with no primary in the set, population order is untouched", () => {
		const ranked = rankByPrimaryPreference([row(-6.0, 0, 1), row(-4.0, 0, 2)], 5)
		expect(ranked.map((r) => r.neg_rank)).toEqual([-6.0, -4.0]) // unchanged
		expect(ranked.every((r) => !r.demoted)).toBe(true)
		expect(ranked.every((r) => r.effectiveNegRank === r.neg_rank)).toBe(true)
	})
})
