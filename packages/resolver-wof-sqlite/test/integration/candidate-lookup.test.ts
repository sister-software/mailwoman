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

import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { createWOFResolver } from "@mailwoman/resolver"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build-candidate"
import { rankByPrimaryPreference, WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite/candidate-lookup"
import { ALIAS_SEPARATOR } from "@mailwoman/resolver-wof-sqlite/fts"
import type { FindPlaceQuery } from "@mailwoman/resolver-wof-sqlite/types"
import { haversineKm } from "@mailwoman/spatial"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

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

		-- The postcode-containment board (#31, B2-2): three same-name US localities whose POPULATION
		-- order disagrees with their distance from postcode 94101's centroid (37.75, -122.42).
		-- big (1.0 M) sits ~550 km away, mid (100 k) ~4,000 km, small (10 k) ~2 km. Population-first
		-- answers big; the containment rung must answer small.
		INSERT INTO spr VALUES (720, 'Sansome', 'locality', 'US', 34.05, -118.24, 34.0, -118.4, 34.1, -118.1, -1, 0);
		INSERT INTO spr VALUES (721, 'Sansome', 'locality', 'US', 38.90, -77.04, 38.8, -77.2, 39.0, -76.9, -1, 0);
		INSERT INTO spr VALUES (722, 'Sansome', 'locality', 'US', 37.76, -122.44, 37.7, -122.5, 37.8, -122.4, -1, 0);

		-- The #1729 seat corridor: a locality/LOCALADMIN duplicate at the same population — the pair that
		-- shares the locality filter group, so BOTH rows enter one locality probe. The localadmin is
		-- stamped the LOWER region id (ancestors below) so the B-tree scan hands the district first and
		-- the seat tiebreak has to hand back the town.
		INSERT INTO spr VALUES (810, 'Seatley', 'locality', 'TR', 40.94, 40.26, 40.9, 40.2, 41.0, 40.3, -1, 0);
		INSERT INTO spr VALUES (811, 'Seatley', 'localadmin', 'TR', 40.88, 40.27, 40.8, 40.2, 41.0, 40.3, -1, 0);
		-- The Of-shape partition case: a locality/COUNTY duplicate at the same population. County is not a
		-- locality-group peer, so a locality probe fetches exactly one row — the seat, by construction.
		INSERT INTO spr VALUES (820, 'Ofton', 'locality', 'TR', 40.94, 40.26, 40.9, 40.2, 41.0, 40.3, -1, 0);
		INSERT INTO spr VALUES (821, 'Ofton', 'county', 'TR', 40.88, 40.34, 40.8, 40.2, 41.0, 40.4, -1, 0);

		-- The #1717 stage-2 containment board, the Weimar shape: 'Marwei' DE (60 k, under region Thuria)
		-- vs a MORE-populous US namesake (2.0 M, under region Texia). Population-first answers the US one
		-- and a hard country=US filter hides the DE one entirely; the containment lever must answer the
		-- DE one in BOTH postures (reorder worldwide, inject under the scope).
		INSERT INTO spr VALUES (900, 'Thuria', 'region', 'DE', 50.9, 11.0, 50.0, 10.0, 51.5, 12.0, -1, 0);
		INSERT INTO spr VALUES (901, 'Marwei', 'locality', 'DE', 50.98, 11.32, 50.9, 11.2, 51.1, 11.4, -1, 0);
		INSERT INTO spr VALUES (902, 'Marwei', 'locality', 'US', 29.70, -96.77, 29.6, -96.9, 29.8, -96.6, -1, 0);
		INSERT INTO spr VALUES (903, 'Texia', 'region', 'US', 31.0, -99.0, 25.8, -106.6, 36.5, -93.5, -1, 0);
		-- The DAG-degraded leg: 'Deggton' DE's CANONICAL (finest) parent is county 906, which carries no
		-- ancestry of its own — so the interval forest roots at 906 and cannot see Thuria above it. The
		-- region edge lives only in the closure rows; containment must fall through to the chain probe.
		INSERT INTO spr VALUES (905, 'Deggton', 'locality', 'DE', 50.99, 11.30, 50.9, 11.2, 51.1, 11.4, -1, 0);
		INSERT INTO spr VALUES (906, 'Countia', 'county', 'DE', 50.95, 11.25, 50.9, 11.2, 51.0, 11.3, -1, 0);
		INSERT INTO spr VALUES (907, 'Deggton', 'locality', 'US', 40.0, -100.0, 39.9, -100.1, 40.1, -99.9, -1, 0);
		-- The country-in-region-slot leg ('Moscow, Russia' parses region="Russia"): a COUNTRY bearer of
		-- the qualifier plus a contained namesake — the qualifier band includes the country placetype.
		INSERT INTO spr VALUES (950, 'Ruslandia', 'country', 'RU', 55.0, 37.0, 41.0, 19.0, 82.0, 179.0, -1, 0);
		INSERT INTO spr VALUES (951, 'Mosgrad', 'locality', 'RU', 55.75, 37.62, 55.5, 37.3, 56.0, 37.9, -1, 0);
		INSERT INTO spr VALUES (952, 'Mosgrad', 'locality', 'US', 46.73, -117.0, 46.6, -117.2, 46.8, -116.8, -1, 0);
		INSERT INTO spr VALUES (990, 'Toledano', 'region', 'ES', 39.8, -4.0, 39.0, -5.0, 40.5, -3.0, -1, 0);
		-- The Donegal-class stored form: an Irish county stored 'County Dundo' (name_key 'county dundo',
		-- no bare 'dundo' key), addressed as 'Co. Dundo' — the probe-side county-prefix variant's board.
		INSERT INTO spr VALUES (960, 'County Dundo', 'region', 'IE', 54.9, -8.0, 54.0, -8.9, 55.4, -7.2, -1, 0);
		INSERT INTO spr VALUES (961, 'Kennytown', 'locality', 'IE', 54.95, -7.72, 54.9, -7.8, 55.0, -7.6, -1, 0);
		INSERT INTO spr VALUES (962, 'Kennytown', 'locality', 'US', 40.0, -77.7, 39.9, -77.8, 40.1, -77.6, -1, 0);
		-- The #1731 Astoria shape: the qualifier's TRUE instance is a NEIGHBOURHOOD — outside the locality
		-- filter group, so no reorder can reach it — while a same-name wrong-instance LOCALITY sits under a
		-- different region. The dependent-band injection must surface the contained neighbourhood.
		INSERT INTO spr VALUES (970, 'Yorkia', 'region', 'US', 42.9, -75.6, 40.5, -79.8, 45.0, -71.8, -1, 0);
		INSERT INTO spr VALUES (971, 'Astorington', 'neighbourhood', 'US', 40.77, -73.92, 40.75, -73.94, 40.79, -73.90, -1, 0);
		INSERT INTO spr VALUES (972, 'Astorington', 'locality', 'US', 46.19, -123.81, 46.1, -123.9, 46.3, -123.7, -1, 0);

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
		INSERT INTO place_population VALUES (720, 1000000);
		INSERT INTO place_population VALUES (721, 100000);
		INSERT INTO place_population VALUES (722, 10000);
		INSERT INTO place_population VALUES (810, 44212);
		INSERT INTO place_population VALUES (811, 44212);
		INSERT INTO place_population VALUES (820, 44212);
		INSERT INTO place_population VALUES (821, 44212);
		INSERT INTO place_population VALUES (901, 60000);
		INSERT INTO place_population VALUES (902, 2000000);
		INSERT INTO place_population VALUES (905, 5000);
		INSERT INTO place_population VALUES (906, 5000);
		INSERT INTO place_population VALUES (907, 800000);
		INSERT INTO place_population VALUES (950, 140000000);
		INSERT INTO place_population VALUES (951, 1000000);
		INSERT INTO place_population VALUES (952, 25000);
		INSERT INTO place_population VALUES (961, 22000);
		INSERT INTO place_population VALUES (962, 250000);
		INSERT INTO place_population VALUES (971, 78000);
		INSERT INTO place_population VALUES (972, 10000);

		-- Region ancestry: build-candidate reads WHERE ancestor_placetype='region' to stamp region_id.
		INSERT INTO ancestors VALUES (310, 400, 'region');
		INSERT INTO ancestors VALUES (311, 401, 'region');
		-- The seat pair's scan order: the localadmin under the lower region id, so it is fetched first.
		INSERT INTO ancestors VALUES (811, 400, 'region');
		INSERT INTO ancestors VALUES (810, 401, 'region');

		-- The containment board's ancestry (the sidecar source). Deggton's TWO parents make the DAG
		-- case: canonical = county 906 (finest tier), region 900 reachable only via the closure rows.
		INSERT INTO ancestors VALUES (901, 900, 'region');
		INSERT INTO ancestors VALUES (902, 903, 'region');
		INSERT INTO ancestors VALUES (905, 906, 'county');
		INSERT INTO ancestors VALUES (905, 900, 'region');
		INSERT INTO ancestors VALUES (951, 950, 'country');
		INSERT INTO ancestors VALUES (961, 960, 'region');
		INSERT INTO ancestors VALUES (971, 970, 'region');

		-- Alias bag: the Russian city's transliteration, so "Moskva" resolves to it.
		INSERT INTO place_search VALUES (300, 'Moskva${ALIAS_SEPARATOR}Moscow City');
		-- The #1730 role shape (the Toledo 'TO' class): a region whose alias bag carries an ABBREVIATION,
		-- marked by the names table's abbreviation KIND (language='abbr', empty privateuse).
		INSERT INTO place_search VALUES (990, 'TD');
		-- The colliding exonym: Farland CN carries an alt-name that normalizes to "zedton" (the Çançun→cancun class).
		INSERT INTO place_search VALUES (601, 'Zedton');
		-- The dominant alt-name: Wyemetro US is aliased to "Wyeburg" (the LA→Los Angeles class).
		INSERT INTO place_search VALUES (603, 'Wyeburg');
		-- The variant-form bridge: the Thuria row also answers the alias key 'Thueria' — the
		-- Thüringen→Thuringia class the fold-equality verdicts declare out of scope, bridged here by
		-- the artifact's own alias keying.
		INSERT INTO place_search VALUES (900, 'Thueria');
	`)

	db.exec(`
		CREATE TABLE names (
			id INTEGER NOT NULL, name TEXT NOT NULL, placetype TEXT NOT NULL DEFAULT '',
			country TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '',
			privateuse TEXT NOT NULL DEFAULT '', official INTEGER NOT NULL DEFAULT 0,
			lastmodified INTEGER NOT NULL DEFAULT 0
		);
		INSERT INTO names VALUES (990, 'TD', 'region', 'ES', 'abbr', '', 0, 0);
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
		-- The B2-2 containment anchor: the Sansome cluster's postcode.
		INSERT INTO spr VALUES (94101, '94101', 'postalcode', 'US', 37.75, -122.42, 37.74, -122.43, 37.76, -122.41, -1, 0);
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
				bias: [{ lat: 46.73, lon: -117, weight: 1 }],
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

	test("excludeNameRoles refuses the abbreviation alias while the role-NULL alias tier stays open (#1730)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// Without the exclusion the abbreviation alias answers — today's bare-race hazard.
			const [open] = await lk.findPlace({ text: "TD", placetype: "region" })
			expect(open?.name).toBe("Toledano")

			// With it, the abbr-stamped row is refused…
			const refused = await lk.findPlace({ text: "TD", placetype: "region", excludeNameRoles: ["abbr", "gloss"] })
			expect(refused).toHaveLength(0)

			// …while a role-NULL exonym alias still answers under the same exclusion (the 格鲁吉亚 contract).
			const [exonym] = await lk.findPlace({
				text: "Moskva",
				placetype: "locality",
				excludeNameRoles: ["abbr", "gloss"],
			})

			expect(exonym?.name).toBe("Moscow")
		} finally {
			lk.close()
		}
	})

	test("excludeNameRoles degrades to a no-op on an artifact without the role column", async () => {
		// A pre-#1730 candidate DB: same columns MINUS name_role. The option must be ignored, never error.
		const legacyPath = join(scratch, "legacy-candidate.db")
		const legacy = new DatabaseSync(legacyPath)

		legacy.exec(`
			CREATE TABLE country_codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
			CREATE TABLE placetype_codes (id INTEGER PRIMARY KEY, placetype TEXT UNIQUE);
			INSERT INTO country_codes VALUES (0, 'ES');
			INSERT INTO placetype_codes VALUES (0, 'region');
			CREATE TABLE candidate (
				name_key TEXT NOT NULL, country_id INTEGER NOT NULL, region_id INTEGER NOT NULL,
				placetype_id INTEGER NOT NULL, neg_rank REAL NOT NULL, spr_id INTEGER NOT NULL,
				name TEXT, latitude REAL, longitude REAL, min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
				population INTEGER, is_primary INTEGER, importance REAL,
				PRIMARY KEY (name_key, country_id, region_id, placetype_id, neg_rank, spr_id)
			) WITHOUT ROWID;
			INSERT INTO candidate VALUES ('td', 0, 0, 0, -5.0, 970, 'Toledano', 39.8, -4.0, 39.0, -5.0, 40.5, -3.0, 700000, 0, NULL);
		`)

		legacy.close()

		const lk = new WOFCandidateTableLookup({ databasePath: legacyPath })

		try {
			const [hit] = await lk.findPlace({ text: "TD", placetype: "region", excludeNameRoles: ["abbr", "gloss"] })
			expect(hit?.name).toBe("Toledano")
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

	test("a typo-corrected row is NOT an exact match (#17)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// `exactMatch` is a MATCH-QUALITY claim, and the trigram tier's whole job is to answer a query
			// that matched nothing. Stamping its rows exact made this backend disagree with the FTS one
			// (where the flag is a real tier discriminator) and, worse, fed a lie to every consumer that
			// filters on it. Span-rescore is the one that got hurt: it enumerates raw spans LONGEST-first
			// and takes the first exact hit, so a 2-token span that only fuzzy-matches out-claimed the
			// 1-token span that matched exactly — measured 2026-08-10, `geocode 'Weimar Thüringen'` came
			// back as Thüringenhausen (population 105) instead of Weimar (65,228), 47.7 km off.
			const exact = await lk.findPlace({ text: "Chicago", placetype: "locality", country: "US" })
			expect(exact[0]?.name).toBe("Chicago")
			expect(exact[0]?.exactMatch).toBe(true)

			const fuzzy = await lk.findPlace({ text: "Chicgo", placetype: "locality", country: "US" })
			// Recall is untouched — the typo still resolves, it just stops claiming to be exact.
			expect(fuzzy[0]?.name).toBe("Chicago")
			expect(fuzzy[0]?.exactMatch).toBe(false)
		} finally {
			lk.close()
		}
	})

	test("the qualifier-strip fallback KEEPS its exact claim — it is a name-key normalization, not a guess", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// "Lenk im Simmental" → "Lenk" strips a qualifier the gazetteer's canonical name omits. That is
			// the same place under a longer label, not a misspelling, so it stays in the exact tier.
			const stripped = await lk.findPlace({ text: "Lenk im Simmental", placetype: "locality", country: "CH" })
			expect(stripped[0]?.name).toBe("Lenk")
			expect(stripped[0]?.exactMatch).toBe(true)
		} finally {
			lk.close()
		}
	})

	test("the fuzzy fallback NEVER fires for postcodes — an unknown code abstains, it does not become a different code", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// "B0601" shares the trigrams {060, 601} with the fixture's real 60601 — exactly the shape
			// that let Northern Ireland's BT3 9QQ trigram-match Sheffield's S3 9QQ after the Code-Point
			// swap (2026-08-05). A "corrected" postcode is a DIFFERENT postcode; the only right answer
			// for an unknown one is no answer.
			expect(await lk.findPlace({ text: "B0601", placetype: "postalcode" })).toHaveLength(0)
			// The same input WITHOUT the postcode placetype may fuzz (it is a name then) — the guard is
			// placetype-scoped, not a global fuzzy kill.
			expect((await lk.findPlace({ text: "Chicgo", placetype: "locality", country: "US" }))[0]?.name).toBe("Chicago")
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
		const ranked = rankByPrimaryPreference([row(-6, 0, 1), row(-4, 0, 2)], 5)
		expect(ranked.map((r) => r.neg_rank)).toEqual([-6, -4]) // unchanged
		expect(ranked.every((r) => !r.demoted)).toBe(true)
		expect(ranked.every((r) => r.effectiveNegRank === r.neg_rank)).toBe(true)
	})
})

describe("rankByPrimaryPreference — exonym-collision band (δ=1.0 population-ratio lever, regression lock)", () => {
	// THE RULE, locked here so it can't silently drift: δ=1.0 (PRIMARY_PREFERENCE_LOG10) means a
	// cross-country ALIAS must be ≥10x more populous than the same-key foreign PRIMARY to win; below 10x the
	// primary wins and the alias is demoted out of the exact tier. This is a population-RATIO proxy for
	// NOTABILITY — the refinement to a true notability signal is tracked as a follow-up.
	//
	// The band the reviewer characterized on the real gazetteer, reproduced with synthetic fixtures so the
	// class is pinned WITHOUT the 3.9 GB live db: "Cancun" → Cancún MX (~5x, flips to the primary);
	// "Florence" → Florence US (Firenze only ~9.5x, under the bar → primary); "Naples" → Napoli IT (~50x)
	// and "Vienna" → Wien AT (~118x) stay foreign. Non-vacuous by construction: a naive unbounded
	// `is_primary DESC` fails the >10x + same-country cases (it would force the primary); a pure-population
	// order fails the <10x case (it would keep the more-populous alias).
	const US = 2
	const IT = 3
	const AT = 4

	// A row from a raw population — build-candidate stores neg_rank = -log10(population + 1), so the pure
	// lever sees exactly the ratios below (alias wins iff (aliasPop + 1) / (primaryPop + 1) > 10).
	const pop = (population: number, is_primary: number, country_id: number) => ({
		neg_rank: -Math.log10(population + 1),
		is_primary,
		country_id,
	})

	test("cross-country alias JUST UNDER 10x loses to the foreign primary (Florence → Florence US)", () => {
		// primary US 100k vs foreign alias IT 950k → ratio ~9.5x < 10x → primary wins, alias demoted.
		const ranked = rankByPrimaryPreference([pop(950_000, 0, IT), pop(100_000, 1, US)], 5)
		expect(ranked[0]!.is_primary).toBe(1)
		expect(ranked[0]!.country_id).toBe(US)
		expect(ranked.find((r) => r.country_id === IT)!.demoted).toBe(true)
	})

	test("cross-country alias WELL OVER 10x still wins (Naples → Napoli / Vienna → Wien class)", () => {
		// primary US 20k vs foreign alias AT ~1.9M → ratio ~95x > 10x → the dominant alias wins, NOT demoted.
		const ranked = rankByPrimaryPreference([pop(1_900_000, 0, AT), pop(20_000, 1, US)], 5)
		expect(ranked[0]!.is_primary).toBe(0)
		expect(ranked[0]!.country_id).toBe(AT)
		expect(ranked[0]!.demoted).toBe(false)
	})

	test("the 10x threshold is tight: 10.5x → alias wins, 9.5x → foreign primary wins", () => {
		// 10.5x → over the bar → the alias wins.
		const over = rankByPrimaryPreference([pop(1_050_000, 0, IT), pop(100_000, 1, US)], 5)
		expect(over[0]!.country_id).toBe(IT)
		expect(over[0]!.is_primary).toBe(0)
		// 9.5x → under the bar → the foreign primary wins.
		const under = rankByPrimaryPreference([pop(950_000, 0, IT), pop(100_000, 1, US)], 5)
		expect(under[0]!.country_id).toBe(US)
		expect(under[0]!.is_primary).toBe(1)
	})

	test("SAME-country collision is unaffected by the ratio lever — population-first at any ratio", () => {
		// primary US 100k vs alias US 950k (same country) → no penalty → the bigger alias wins even at ~9.5x
		// (below the cross-country bar) and is never demoted. A naive `is_primary DESC` would wrongly pick the
		// primary here — this is the guard that the lever stays CROSS-country-only.
		const ranked = rankByPrimaryPreference([pop(950_000, 0, US), pop(100_000, 1, US)], 5)
		expect(ranked[0]!.is_primary).toBe(0)
		expect(ranked[0]!.demoted).toBe(false)
	})
})

describe("rankByPrimaryPreference — variant-alias exemption (#1882, opt-in)", () => {
	const IT = 3
	const BY = 5
	const FR = 6
	const MX = 7
	const CN = 8

	const pop = (population: number, is_primary: number, country_id: number, name_role: string | null = null) => ({
		neg_rank: -Math.log10(population + 1),
		is_primary,
		country_id,
		population,
		name_role,
	})

	test("an own-name variant alias escapes the penalty when the exemption is ON (Brest → Belarus)", () => {
		// Брэст BY 340,521 (alias keyed `brest`, stamped `variant` by the build) vs Brest FR 144,899
		// (primary). OFF: the 2.35x gap is under the 10x margin → FR wins and BY is demoted. ON: the
		// stamp says the alias IS the holder's own name → population order stands.
		const rows = [pop(340_521, 0, BY, "variant"), pop(144_899, 1, FR)]

		const off = rankByPrimaryPreference(rows, 5)
		expect(off[0]!.country_id).toBe(FR)
		expect(off.find((r) => r.country_id === BY)!.demoted).toBe(true)

		const on = rankByPrimaryPreference(rows, 5, undefined, undefined, true)
		expect(on[0]!.country_id).toBe(BY)
		expect(on[0]!.demoted).toBe(false)
	})

	test("an UN-stamped alias keeps the penalty even with the exemption ON (Cancún stays protected)", () => {
		// Changchun CN 4.19M holding the coincidental alias `cancun` (no stamp — the own-name detector
		// refuses it) vs Cancún MX 890k primary. The exemption must not touch this class.
		const rows = [pop(4_190_000, 0, CN), pop(890_000, 1, MX)]
		const on = rankByPrimaryPreference(rows, 5, undefined, undefined, true)

		expect(on[0]!.country_id).toBe(MX)
		expect(on.find((r) => r.country_id === CN)!.demoted).toBe(true)
	})

	test("a pre-role artifact no-ops by construction — no name_role on any row, ON output equals OFF", () => {
		const rows = [pop(340_521, 0, BY), pop(144_899, 1, FR), pop(20_000, 1, IT)]
		const off = rankByPrimaryPreference(rows, 5)
		const on = rankByPrimaryPreference(rows, 5, undefined, undefined, true)

		expect(on.map((r) => [r.country_id, r.effectiveNegRank, r.demoted])).toEqual(
			off.map((r) => [r.country_id, r.effectiveNegRank, r.demoted])
		)
	})

	test("with the exemption OFF (the default), a stamped row still takes the penalty — the stamp alone changes nothing", () => {
		const rows = [pop(340_521, 0, BY, "variant"), pop(144_899, 1, FR)]
		const off = rankByPrimaryPreference(rows, 5)

		expect(off[0]!.country_id).toBe(FR)
	})
})

describe("postcode-containment coherence (#31, Mechanism 2)", () => {
	// The B2-2 board: three same-name US localities whose POPULATION order disagrees with their
	// distance from postcode 94101's centroid (37.75, -122.42): big (720, 1.0 M, ~550 km away),
	// mid (721, 100 k, ~4,000 km), small (722, 10 k, ~2 km). Population-first answers big; the
	// containment rung must answer small.
	const ANCHOR = { lat: 37.75, lon: -122.42 }
	const SANSOME_BIG = 720
	const SANSOME_MID = 721
	const SANSOME_SMALL = 722

	const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode => ({
		start: 0,
		end: over.value.length,
		confidence: 0.95,
		children: [],
		...over,
	})

	const tree = (...roots: AddressNode[]): AddressTree => ({
		raw: roots.map((r) => r.value).join(" "),
		roots,
	})

	const sansomeQuery = (extra: Partial<FindPlaceQuery> = {}): FindPlaceQuery => ({
		text: "Sansome",
		placetype: "locality",
		country: "US",
		limit: 5,
		...extra,
	})

	function tagged(roots: readonly AddressNode[], tag: string): AddressNode[] {
		const out: AddressNode[] = []
		const stack = [...roots]

		while (stack.length) {
			const n = stack.pop()!

			if (n.tag === tag) {
				out.push(n)
			}

			stack.push(...n.children)
		}

		return out
	}

	test("B2-1: the #741 postal-city short-circuit is untouched — an exact (name, postcode) hit wins with the flag on or off", async () => {
		// Patch the built candidate DB with the #741 side-index carrying the exact hit; the lookup
		// existence-gates its probe on the table, so this is the real fast-path configuration.
		const db = new DatabaseSync(candidatePath)

		db.exec(
			"CREATE TABLE postal_city_candidate (name_key TEXT, postcode TEXT, spr_id INTEGER, name TEXT, latitude REAL, longitude REAL)"
		)

		db.prepare("INSERT INTO postal_city_candidate VALUES (?, ?, ?, ?, ?, ?)").run(
			"sansome",
			"94101",
			SANSOME_SMALL,
			"Sansome",
			37.76,
			-122.44
		)

		db.close()

		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const off = await lk.findPlace(sansomeQuery({ postcode: "94101" }))
			const on = await lk.findPlace(sansomeQuery({ postcode: "94101", postcodeContainmentCoherence: true }))

			// Byte-identical: the exact probe answers the single geographic locality; the re-rank rung
			// sits strictly beneath it and never sees the three-row candidate set.
			expect(on).toEqual(off)
			expect(on).toHaveLength(1)
			expect(on[0]!.id).toBe(SANSOME_SMALL)
		} finally {
			lk.close()
		}
	})

	test("B2-2: in-gate rows sort by distance first, the out-gate tail keeps its population order", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace(sansomeQuery({ postcode: "94101", postcodeContainmentCoherence: true }))

			expect(hits.map((c) => c.id)).toEqual([SANSOME_SMALL, SANSOME_BIG, SANSOME_MID])
			// The winner is the locality CONTAINING the postcode — within the bar's ≤5 km of its centroid.
			expect(haversineKm(ANCHOR.lat, ANCHOR.lon, hits[0]!.lat, hits[0]!.lon)).toBeLessThanOrEqual(5)
			// The out-gate tail (big before mid) is the ORIGINAL population-first order, untouched.
		} finally {
			lk.close()
		}
	})

	test("B2-2: the postcode-removed arm is unchanged — and the gap the bar claims is real", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// No postcode → the rung cannot fire → population-first.
			const bare = await lk.findPlace(sansomeQuery())
			expect(bare.map((c) => c.id)).toEqual([SANSOME_BIG, SANSOME_MID, SANSOME_SMALL])

			// A postcode WITHOUT the flag is byte-identical to no postcode (the flag is the gate).
			const flagless = await lk.findPlace(sansomeQuery({ postcode: "94101" }))
			expect(flagless.map((c) => c.id)).toEqual([SANSOME_BIG, SANSOME_MID, SANSOME_SMALL])

			// The population-first winner is ~550 km from the postcode — removing the postcode moves the
			// answer far outside the gate, so the mechanism is doing what the bar claims it does.
			expect(haversineKm(ANCHOR.lat, ANCHOR.lon, bare[0]!.lat, bare[0]!.lon)).toBeGreaterThan(25)
		} finally {
			lk.close()
		}
	})

	test("B2-2: an anchor miss abstains — a postcode the table doesn't carry leaves the order untouched", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace(sansomeQuery({ postcode: "99999", postcodeContainmentCoherence: true }))
			expect(hits.map((c) => c.id)).toEqual([SANSOME_BIG, SANSOME_MID, SANSOME_SMALL])
		} finally {
			lk.close()
		}
	})

	test("B2-2: a single-row candidate set is a no-op — the rung only fires when there is a tie to break", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const [hit] = await lk.findPlace({
				text: "Chicago",
				placetype: "locality",
				postcode: "94101",
				postcodeContainmentCoherence: true,
			})

			expect(hit?.id).toBe(200)
			expect(hit?.name).toBe("Chicago")
		} finally {
			lk.close()
		}
	})

	test("B2-2 resolver-level: postcode present → the ≤5 km locality; postcode removed → population-first far away", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		const resolver = createWOFResolver(lk)

		try {
			const withPC = await resolver.resolveTree(
				tree(node({ tag: "locality", value: "Sansome" }), node({ tag: "postcode", value: "94101" })),
				{ postcodeContainmentCoherence: true }
			)

			const sansPostcode = await resolver.resolveTree(tree(node({ tag: "locality", value: "Sansome" })), {})

			const near = tagged(withPC.roots, "locality")[0]!
			const far = tagged(sansPostcode.roots, "locality")[0]!

			expect(near.placeID).toBe("wof:722")
			expect(far.placeID).toBe("wof:720")
			expect(haversineKm(ANCHOR.lat, ANCHOR.lon, near.lat!, near.lon!)).toBeLessThanOrEqual(5)
			expect(haversineKm(ANCHOR.lat, ANCHOR.lon, far.lat!, far.lon!)).toBeGreaterThan(25)
		} finally {
			lk.close()
		}
	})

	test("B2-3: the double-repair arms agree — postcodeConsistency ON vs OFF pick the same locality", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		const resolver = createWOFResolver(lk)

		try {
			const mkTree = () => tree(node({ tag: "locality", value: "Sansome" }), node({ tag: "postcode", value: "94101" }))

			const withConsistency = await resolver.resolveTree(mkTree(), { postcodeContainmentCoherence: true })

			const withoutConsistency = await resolver.resolveTree(mkTree(), {
				postcodeContainmentCoherence: true,
				postcodeConsistency: false,
			})

			const a = tagged(withConsistency.roots, "locality")[0]!
			const b = tagged(withoutConsistency.roots, "locality")[0]!

			// The containment rung picks small; the consistency pass (default-ON) is already satisfied and
			// must NOT re-pick with a different tie-break — both arms land on the same locality.
			expect(a.placeID).toBe("wof:722")
			expect(b.placeID).toBe(a.placeID)
			expect(a.lat).toBeCloseTo(37.76, 2)
		} finally {
			lk.close()
		}
	})
})

/**
 * The read side of the #28 fame column: `candidate.importance` → `PlaceCandidate.importance`.
 *
 * Three states have to be distinguishable, because the consumer (`resolver/toponym-prior.ts`) treats exactly one of
 * them as evidence:
 *
 * 1. The artifact scored this place → the field is present;
 * 2. The artifact has the column but no measurement for this place → the field is ABSENT (not 0);
 * 3. The artifact predates the column entirely → the field is absent, and nothing throws.
 */
describe("WOFCandidateTableLookup — importance (#28)", () => {
	let scoredPath: string

	/**
	 * A score source for the lookup fixture's homonym pair. Moscow RU is scored ABOVE Moscow, Idaho; Chicago is scored;
	 * Lenk deliberately is not. Ids are unrelated to the admin fixture's, as they are in production.
	 */
	function buildFixtureImportance(path: string): void {
		const db = new DatabaseSync(path)

		db.exec(`
			CREATE TABLE spr (
				id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
				latitude REAL, longitude REAL, is_current INTEGER, is_deprecated INTEGER
			);
			CREATE TABLE place_importance (id INTEGER PRIMARY KEY, importance REAL NOT NULL);

			INSERT INTO spr VALUES (7000000000300, 'Moscow', 'locality', 'RU', 55.75, 37.62, -1, 0);
			INSERT INTO spr VALUES (7000000000301, 'Moscow', 'locality', 'US', 46.73, -117.00, -1, 0);
			INSERT INTO spr VALUES (7000000000200, 'Chicago', 'locality', 'US', 41.88, -87.63, -1, 0);

			INSERT INTO place_importance VALUES (7000000000300, 0.9530);
			INSERT INTO place_importance VALUES (7000000000301, 0.5465);
			INSERT INTO place_importance VALUES (7000000000200, 0.8125);
		`)

		db.close()
	}

	beforeEach(async () => {
		const input = join(scratch, "admin-scored.db")
		const importance = join(scratch, "importance.db")
		scoredPath = join(scratch, "candidate-scored.db")
		buildFixtureAdmin(input)
		buildFixtureImportance(importance)
		await buildCandidateTable({ input, output: scoredPath, importance })
	})

	test("surfaces a measured score as `importance`", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: scoredPath })

		try {
			const hits = await lk.findPlace({ text: "Moscow", placetype: "locality", limit: 5 })
			expect(hits).toHaveLength(2)
			expect(hits[0]!.country).toBe("RU")
			expect(hits[0]!.importance).toBeCloseTo(0.953, 4)
			expect(hits[1]!.importance).toBeCloseTo(0.5465, 4)
		} finally {
			lk.close()
		}
	})

	test("an ALIAS row carries the place's score (the Москва → 'moscow' path)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: scoredPath })

		try {
			// "Moskva" is an alt-name of the same RU place; the row is denormalized onto that place, so it
			// must report the place's fame, not nothing.
			const hits = await lk.findPlace({ text: "Moskva", placetype: "locality", limit: 5 })
			expect(hits).toHaveLength(1)
			expect(hits[0]!.country).toBe("RU")
			expect(hits[0]!.importance).toBeCloseTo(0.953, 4)
		} finally {
			lk.close()
		}
	})

	test("an unmeasured place omits the field entirely — absent, not zero", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: scoredPath })

		try {
			const hits = await lk.findPlace({ text: "Lenk", placetype: "locality", limit: 5 })
			expect(hits).toHaveLength(1)
			// `undefined`, and the KEY must not be present at all — `rankByImportance` reads a 0 as a
			// measurement and would let a scored hamlet leapfrog an unscored metropolis.
			expect(hits[0]!.importance).toBeUndefined()
			expect("importance" in hits[0]!).toBe(false)
		} finally {
			lk.close()
		}
	})

	test("an artifact built WITHOUT a score source reports no fame anywhere", async () => {
		// `candidatePath` is the shared fixture, built with no `importance` option.
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Moscow", placetype: "locality", limit: 5 })
			expect(hits).toHaveLength(2)
			expect(hits.every((h) => h.importance === undefined)).toBe(true)
		} finally {
			lk.close()
		}
	})

	test("an artifact PREDATING the column still resolves — the probe is existence-gated", async () => {
		// Reproduce a pre-#28 gazetteer by removing the column from a real build, rather than hand-writing
		// an old DDL that could drift from what the old builder actually emitted.
		const legacyPath = join(scratch, "candidate-legacy.db")
		await copyFile(scoredPath, legacyPath)
		const rw = new DatabaseSync(legacyPath)
		rw.exec("ALTER TABLE candidate DROP COLUMN importance")
		rw.close()

		const lk = new WOFCandidateTableLookup({ databasePath: legacyPath })

		try {
			const hits = await lk.findPlace({ text: "Moscow", placetype: "locality", limit: 5 })
			expect(hits).toHaveLength(2)
			expect(hits[0]!.country).toBe("RU")
			expect(hits.every((h) => h.importance === undefined)).toBe(true)
		} finally {
			lk.close()
		}
	})
})

describe("rankByPrimaryPreference — seat preference on a coincident same-name duplicate", () => {
	// A district and its identically-named seat town carry the SAME population, so `neg_rank` ties to the
	// bit and the pair's order falls out of the SQL scan. Turkey's `Of` is the measured case: locality
	// 8114738869649 and its parent county 8837168432019 both hold population 44212 in
	// `admin-global-priority.db`; 358 locality/parent-county pairs across 15 countries share the shape.
	const PLACETYPES: ReadonlyMap<number, string> = new Map([
		[3, "region"],
		[5, "county"],
		[7, "locality"],
		[10, "neighbourhood"],
		[12, "postalcode"],
	])

	const POPULATION = 44_212
	const NEG_RANK = -Math.log10(POPULATION + 1)

	const at = (placetype_id: number, population = POPULATION) => ({
		neg_rank: NEG_RANK,
		is_primary: 1,
		country_id: 1,
		placetype_id,
		population,
	})

	const county = at(5)
	const locality = at(7)

	test("the seat wins its district regardless of scan order (Of TR: the town, not the district)", () => {
		expect(rankByPrimaryPreference([county, locality], 5, undefined, PLACETYPES)[0]!.placetype_id).toBe(7)
		expect(rankByPrimaryPreference([locality, county], 5, undefined, PLACETYPES)[0]!.placetype_id).toBe(7)
	})

	test("without the placetype map the term is inert — scan order is preserved", () => {
		expect(rankByPrimaryPreference([county, locality], 5)[0]!.placetype_id).toBe(5)
		expect(rankByPrimaryPreference([locality, county], 5)[0]!.placetype_id).toBe(7)
	})

	test("population still outranks the seat preference — the term only fires on an exact tie", () => {
		const biggerCounty = { ...county, neg_rank: NEG_RANK - 1 }
		expect(rankByPrimaryPreference([locality, biggerCounty], 5, undefined, PLACETYPES)[0]!.placetype_id).toBe(5)
	})

	test("a population-0 tie is NO EVIDENCE, not equal evidence — the term stays off it", () => {
		// 7,179 of the 11,377 top-slot moves an unguarded "finer wins" produced sat here. Scan order stands.
		const zeroCounty = at(5, 0)
		const zeroLocality = at(7, 0)
		expect(rankByPrimaryPreference([zeroCounty, zeroLocality], 5, undefined, PLACETYPES)[0]!.placetype_id).toBe(5)
	})

	test("a contest between distinct places is left alone — only the seat tier is promoted", () => {
		// The three transitions an unguarded specificity term moved most: region→county (2,973),
		// locality→neighbourhood (2,885), postalcode→locality (2,662). None is a duplicate; all keep scan order.
		expect(rankByPrimaryPreference([at(3), at(5)], 5, undefined, PLACETYPES)[0]!.placetype_id).toBe(3)
		expect(rankByPrimaryPreference([at(7), at(10)], 5, undefined, PLACETYPES)[0]!.placetype_id).toBe(7)
		expect(rankByPrimaryPreference([at(10), at(7)], 5, undefined, PLACETYPES)[0]!.placetype_id).toBe(7)
	})

	test("an unknown placetype id sorts behind the seat rather than throwing", () => {
		expect(rankByPrimaryPreference([at(99), locality], 5, undefined, PLACETYPES)[0]!.placetype_id).toBe(7)
	})
})

describe("seat preference through findPlace — where the term can and cannot reach (#1729)", () => {
	// The walk's probes always carry a placetype filter, so the seat term only meets a tie the filter
	// group lets co-occur. These two fixtures pin both halves of that reach: the in-group pair the
	// term decides, and the Of-shape pair the filter partitions before any ranking runs.

	test("a locality/localadmin duplicate enters ONE locality probe and the seat wins it", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Seatley", placetype: "locality", limit: 5 })

			// localadmin is a locality-group peer (PLACETYPE_FILTER_GROUPS), so BOTH rows are in the set…
			expect(hits.map((h) => h.placetype).toSorted()).toEqual(["localadmin", "locality"])
			// …and the seat tiebreak orders the town over its district even though the district is
			// fetched first (its region id sorts lower in the clustered key). This ordering is the
			// term's ONLY corridor to an end-to-end answer — the resolver's downstream sorts are
			// stable on equal keys (toponym-prior.ts house rule 3) — so it is the mechanism's reach,
			// not a cosmetic preference.
			expect(hits[0]!.placetype).toBe("locality")
			expect(hits[0]!.id).toBe(810)
		} finally {
			lk.close()
		}
	})

	test("a locality/county duplicate is PARTITIONED before ranking — the locality probe fetches one row", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Ofton", placetype: "locality", limit: 5 })

			// County is not a locality-group peer: the Of-shape seat/district pair never co-occurs in
			// a walk probe, so the seat term cannot decide it end-to-end — the placetype filter
			// selects the seat by construction, and only an UNFILTERED probe (the browser cascade's
			// last resort, the dev lookup tools) ever presents this tie to the ranker.
			expect(hits).toHaveLength(1)
			expect(hits[0]!.id).toBe(820)
			expect(hits[0]!.placetype).toBe("locality")
		} finally {
			lk.close()
		}
	})
})

describe("admin-containment re-rank through findPlace (#1717 stage 2)", () => {
	// The fixture is the Weimar shape: 'Marwei' DE (60 k, under region Thuria) vs a MORE-populous US
	// namesake (2.0 M). Population-first answers the US one; a country=US scope hides the DE one; the
	// qualifier must answer the DE one in both postures. The board-measured mechanism (2026-08-18):
	// the locale-inferred hard filter partitions the true instance out of the list BEFORE any
	// comparator, so a reorder-only lever would be inert — the #1729 class, which is why these
	// fixtures pin INJECTION, not just ordering.

	test("#1731: a contained NEIGHBOURHOOD is injected past the locality filter group", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({
				text: "Astorington",
				placetype: "locality",
				regionQualifier: "Yorkia",
				limit: 5,
			})

			// The locality-group pool holds only the wrong-instance locality (972, under no qualifier
			// ancestry); the TRUE instance is a neighbourhood the filter group cannot reach. The
			// dependent-band injection admits it on containment proof and the shared partition puts it
			// first. Without the band, this query answers 972 — the Astoria chimera's first half.
			expect(hits[0]!.id).toBe(971)
			expect(hits[0]!.placetype).toBe("neighbourhood")
			expect(hits[0]!.containedByQualifier).toBe(true)
			expect(hits.map((h) => h.id)).toContain(972)
		} finally {
			lk.close()
		}
	})

	test("REORDERS the worldwide set: the contained namesake beats the more-populous one", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Marwei", placetype: "locality", regionQualifier: "Thuria", limit: 5 })

			expect(hits.map((h) => h.id)).toEqual([901, 902])
			expect(hits[0]!.country).toBe("DE")
			expect(hits[0]!.containedByQualifier).toBe(true)
			expect(hits[1]!.containedByQualifier).toBe(false)
		} finally {
			lk.close()
		}
	})

	test("INJECTS past a country scope: the contained instance the hard filter hid re-enters the list", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// Without the qualifier, the US scope makes the DE row unreachable at any rank.
			const scoped = await lk.findPlace({ text: "Marwei", placetype: "locality", country: "US", limit: 5 })

			expect(scoped.map((h) => h.id)).toEqual([902])

			// With it, the sidecar-vouched instance is ADDED and ranked first — the scoped row survives
			// as the runner-up (additive, never a filter).
			const hits = await lk.findPlace({
				text: "Marwei",
				placetype: "locality",
				country: "US",
				regionQualifier: "Thuria",
				limit: 5,
			})

			expect(hits.map((h) => h.id)).toEqual([901, 902])
			expect(hits[0]!.country).toBe("DE")
			expect(hits[0]!.exactMatch).toBe(true)
		} finally {
			lk.close()
		}
	})

	test("bridges a variant-form qualifier through the artifact's own alias keys", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// 'Thueria' is an alias key of the Thuria region row — the Thüringen→Thuringia class the
			// fold-equality verdicts (their stated v1 bound) cannot bridge; the qualifier probe can.
			const hits = await lk.findPlace({
				text: "Marwei",
				placetype: "locality",
				country: "US",
				regionQualifier: "Thueria",
				limit: 5,
			})

			expect(hits[0]!.id).toBe(901)
		} finally {
			lk.close()
		}
	})

	test("falls through to the CLOSURE rows where the interval forest cannot see the qualifier (DAG)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// Deggton DE's canonical parent is the ancestry-less county, so its interval label sits in a
			// different tree than Thuria's — the interval verdict is 'not contained along the canonical
			// hierarchy', and only the closure chain knows better.
			const hits = await lk.findPlace({ text: "Deggton", placetype: "locality", regionQualifier: "Thuria", limit: 5 })

			expect(hits.map((h) => h.id)).toEqual([905, 907])
			expect(hits[0]!.country).toBe("DE")
		} finally {
			lk.close()
		}
	})

	test("meets a 'County X' stored form addressed as 'Co. X' — the probe-side prefix variant", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// The stored fold is 'county dundo' with no bare 'dundo' key; the qualifier's own strip goes
			// the OTHER way ('Co. Dundo' → 'dundo'), so a one-sided probe would miss what the verdicts'
			// two-sided set intersection meets — the exact reason `regionQualifierProbeKeys` exists.
			const hits = await lk.findPlace({
				text: "Kennytown",
				placetype: "locality",
				regionQualifier: "Co. Dundo",
				limit: 5,
			})

			expect(hits.map((h) => h.id)).toEqual([961, 962])
			expect(hits[0]!.country).toBe("IE")
		} finally {
			lk.close()
		}
	})

	test("answers a COUNTRY name in the region slot — the parse-mislabel class ('Moscow, Russia')", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({
				text: "Mosgrad",
				placetype: "locality",
				country: "US",
				regionQualifier: "Ruslandia",
				limit: 5,
			})

			expect(hits.map((h) => h.id)).toEqual([951, 952])
			expect(hits[0]!.country).toBe("RU")
		} finally {
			lk.close()
		}
	})

	test("SOFT, never a filter: a qualifier that matches nothing changes nothing (and says it was asked)", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const plain = await lk.findPlace({ text: "Marwei", placetype: "locality", limit: 5 })

			const hits = await lk.findPlace({
				text: "Marwei",
				placetype: "locality",
				regionQualifier: "Nowhereshire",
				limit: 5,
			})

			expect(hits.map((h) => h.id)).toEqual(plain.map((h) => h.id))
			// Evaluated, not silently skipped: the stamps are present and false, so the walk's verdict
			// reads no_contained_candidate rather than unavailable.
			expect(hits.every((h) => h.containedByQualifier === false)).toBe(true)
		} finally {
			lk.close()
		}
	})

	test("an uncontained qualifier (wrong region) leaves the population order untouched", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			// 'Texia' contains the US namesake, which already leads on population — stamped, unmoved.
			const hits = await lk.findPlace({ text: "Marwei", placetype: "locality", regionQualifier: "Texia", limit: 5 })

			expect(hits.map((h) => h.id)).toEqual([902, 901])
			expect(hits[0]!.containedByQualifier).toBe(true)
			expect(hits[1]!.containedByQualifier).toBe(false)
		} finally {
			lk.close()
		}
	})

	test("CAPABILITY-GATED: a pre-sidecar artifact ignores the qualifier and stamps nothing", async () => {
		// Reproduce a pre-sidecar candidate.db by dropping the tables from a real build — the same
		// vintage discipline as the pre-#28 importance-column test above.
		const preSidecarPath = join(scratch, "candidate-pre-sidecar.db")
		await copyFile(candidatePath, preSidecarPath)
		const rw = new DatabaseSync(preSidecarPath)
		rw.exec("DROP TABLE candidate_ancestor; DROP TABLE candidate_interval;")
		rw.close()

		const lk = new WOFCandidateTableLookup({ databasePath: preSidecarPath })

		try {
			const hits = await lk.findPlace({ text: "Marwei", placetype: "locality", regionQualifier: "Thuria", limit: 5 })

			// Population-first, unmoved — and NO stamp, so the walk reports the lever `unavailable`
			// rather than reading the absence as "not contained" (meaning-of-zero).
			expect(hits.map((h) => h.id)).toEqual([902, 901])
			expect(hits.every((h) => !("containedByQualifier" in h))).toBe(true)
		} finally {
			lk.close()
		}
	})

	test("no qualifier on the query → no stamps, byte-identical to the incumbent path", async () => {
		const lk = new WOFCandidateTableLookup({ databasePath: candidatePath })

		try {
			const hits = await lk.findPlace({ text: "Marwei", placetype: "locality", limit: 5 })

			expect(hits.map((h) => h.id)).toEqual([902, 901])
			expect(hits.every((h) => !("containedByQualifier" in h))).toBe(true)
		} finally {
			lk.close()
		}
	})
})
