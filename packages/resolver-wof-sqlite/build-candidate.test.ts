/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildCandidateTable} — the FTS-free byte-range candidate gazetteer the
 *   browser demo resolves against. Builds a tiny fixture admin WOF (the production source shape:
 *   `spr` + `place_population` + `place_search` alt-name bags + `place_abbr` + `ancestors`) plus a
 *   postcode shard, then asserts the four disciplines the resolver depends on:
 *
 *   1. **Denormalized single-probe shape** — every candidate row carries name + centroid + bbox +
 *        country/placetype codes, so a resolve is one statement (no join to spr).
 *   2. **Shared-normalizer parity** — the `name_key` is {@link normalizeLocalityForKey}, the SAME
 *        function the query side uses; a diacritic name keys to its folded form by construction.
 *   3. **page_size = 8192** — set right before VACUUM (node:sqlite creates the file at 4096).
 *   4. **The passes** — primaries, alias bags, region abbreviations, postcode shards (with the
 *        `latitude!=0 AND longitude!=0` placeholder-coord filter), and each shard's `names`-table
 *        delivery-city aliases (#1495).
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildCandidateTable, type PlaceAttrs, stageCountryDisplayNames } from "./build-candidate.ts"
import { normalizeLocalityForKey } from "./street-normalize.ts"

const ALIAS_SEP = "\u{E000}"

let scratch: string

/**
 * A minimal admin WOF with the tables `buildCandidateTable` reads.
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

		-- ancestors (kept; region tier drives same-name disambiguation)
		INSERT INTO spr VALUES (100, 'United States', 'country', 'US', 39.0, -97.0, 24.5, -125.0, 49.4, -66.9, -1, 0);
		INSERT INTO spr VALUES (101, 'Illinois', 'region', 'US', 40.0, -89.0, 37.0, -91.5, 42.5, -87.0, -1, 0);

		-- localities (varying population → neg_rank order)
		INSERT INTO spr VALUES (200, 'Chicago', 'locality', 'US', 41.88, -87.63, 41.6, -87.9, 42.0, -87.5, -1, 0);
		INSERT INTO spr VALUES (201, 'Springfield', 'locality', 'US', 39.80, -89.65, 39.7, -89.8, 39.9, -89.5, -1, 0);
		-- diacritic locality — exercises shared-normalizer parity (Saint-Étienne → saint-etienne)
		INSERT INTO spr VALUES (202, 'Saint-Étienne', 'locality', 'FR', 45.43, 4.39, 45.40, 4.35, 45.47, 4.43, -1, 0);

		-- deprecated row — must be excluded by is_current!=0 AND is_deprecated=0
		INSERT INTO spr VALUES (500, 'Old Town', 'locality', 'US', 40.0, -89.0, 40.0, -89.0, 40.0, -89.0, 1, 1);

		INSERT INTO place_population VALUES (100, 331000000);
		INSERT INTO place_population VALUES (101, 12700000);
		INSERT INTO place_population VALUES (200, 2700000);
		INSERT INTO place_population VALUES (201, 114000);
		INSERT INTO place_population VALUES (202, 170000);

		-- alt-name bags (U+E000-separated); Chicago carries a colloquial alias
		INSERT INTO place_search VALUES (200, 'Chi-Town${ALIAS_SEP}Windy City');
		INSERT INTO place_search VALUES (202, 'St Etienne');

		-- region abbreviation
		INSERT INTO place_abbr VALUES (101, 'IL');

		-- region-tier ancestry (Chicago + Springfield ⊂ Illinois)
		INSERT INTO ancestors VALUES (200, 101, 'region');
		INSERT INTO ancestors VALUES (201, 101, 'region');
		INSERT INTO ancestors VALUES (202, 101, 'region');
	`)

	db.close()
}

/**
 * A postcode shard: `spr` with placetype='postalcode', plus the `names` table `createUnifiedSchema` gives every real
 * shard — that's where `postcode/centroid-fills.ts` writes the GeoNames delivery-city names (#1495). One real-coord ZIP
 * + one placeholder 0,0.
 *
 * @param withNames Build the shard WITHOUT a `names` table, to cover the tolerate-and-say-so path.
 */
function buildFixturePostcodes(path: string, withNames = true): void {
	const db = new DatabaseSync(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		-- real coords → kept
		INSERT INTO spr VALUES (60601, '60601', 'postalcode', 'US', 41.885, -87.62, 41.88, -87.63, 41.89, -87.61, -1, 0);
		-- placeholder 0,0 coords → dropped by the latitude!=0 AND longitude!=0 filter (the White House 20500 case)
		INSERT INTO spr VALUES (20500, '20500', 'postalcode', 'US', 0, 0, 0, 0, 0, 0, -1, 0);
		-- 11201 is the canonical delivery-city case: USPS calls it Brooklyn, WOF files it under locality New York
		INSERT INTO spr VALUES (11201, '11201', 'postalcode', 'US', 40.694, -73.99, 40.68, -74.01, 40.70, -73.97, -1, 0);
	`)

	if (withNames) {
		db.exec(`
			CREATE TABLE names (
				id INTEGER NOT NULL, name TEXT NOT NULL, placetype TEXT NOT NULL DEFAULT '',
				country TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '',
				privateuse TEXT NOT NULL DEFAULT '', official INTEGER NOT NULL DEFAULT 0,
				lastmodified INTEGER NOT NULL DEFAULT 0
			);
			-- what geonamesNameFill() writes: official = 0, because a delivery city is what the postal
			-- system calls the place, not an official name OF it
			INSERT INTO names VALUES (11201, 'Brooklyn', 'postalcode', 'US', '', '', 0, 0);
			-- the shard's own display form for the same id — must not become a second alias row
			INSERT INTO names VALUES (11201, '11201', 'postalcode', 'US', '', '', 0, 0);
			-- an alias on a row the coord filter dropped: no primary was staged, so it has nothing to hang on
			INSERT INTO names VALUES (20500, 'The White House', 'postalcode', 'US', '', '', 0, 0);
		`)
	}

	db.close()
}

interface CandRow {
	name_key: string
	name: string
	country: string
	placetype: string
	latitude: number
	longitude: number
	min_lat: number
	is_primary: number
	population: number
}

/**
 * Resolve a normalized key the way the query side does — join the code maps back to strings.
 */
function probe(db: DatabaseSync, key: string): CandRow[] {
	return db
		.prepare(
			`SELECT c.name_key, c.name, cc.code AS country, pc.placetype AS placetype,
				c.latitude, c.longitude, c.min_lat, c.is_primary, c.population
			 FROM candidate c
			 JOIN country_codes cc ON cc.id = c.country_id
			 JOIN placetype_codes pc ON pc.id = c.placetype_id
			 WHERE c.name_key = ? ORDER BY c.neg_rank ASC`
		)
		.all(key) as unknown as CandRow[]
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-candidate-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("buildCandidateTable", () => {
	test("builds a denormalized single-probe row for each primary, keyed by the shared normalizer", async () => {
		const input = join(scratch, "admin.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)

		const result = await buildCandidateTable({ input, output })
		// 3 localities + 2 ancestors = 5 primaries (deprecated Old Town excluded).
		expect(result.primaries).toBe(5)
		expect(result.places).toBe(5)

		const db = new DatabaseSync(output, { readOnly: true })

		try {
			const [chi] = probe(db, normalizeLocalityForKey("Chicago"))
			expect(chi).toBeDefined()
			// Denormalized: the row carries everything the resolver needs, no join to spr.
			expect(chi!.name).toBe("Chicago")
			expect(chi!.country).toBe("US")
			expect(chi!.placetype).toBe("locality")
			expect(chi!.latitude).toBeCloseTo(41.88, 2)
			expect(chi!.min_lat).toBeCloseTo(41.6, 2)
			expect(chi!.is_primary).toBe(1)

			// Deprecated row must not resolve.
			expect(probe(db, normalizeLocalityForKey("Old Town"))).toHaveLength(0)
		} finally {
			db.close()
		}
	})

	test("falls back to the codex population for a COUNTRY row WOF carries none for (#1650)", async () => {
		const input = join(scratch, "admin.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)

		// Georgia the country, with NO place_population row — the measured state of 147 of 237 primary
		// country records. Without the fallback it enters every prominence race at an asserted zero.
		const src = new DatabaseSync(input)
		src.exec(`INSERT INTO spr VALUES (300, 'Georgia', 'country', 'GE', 42.0, 43.5, 41.0, 40.0, 43.6, 46.7, -1, 0)`)
		src.close()

		await buildCandidateTable({ input, output })

		const db = new DatabaseSync(output, { readOnly: true })

		try {
			const rows = probe(db, normalizeLocalityForKey("Georgia"))
			const country = rows.find((r) => r.placetype === "country")

			expect(country?.population).toBe(3_704_500)

			// The fallback is COUNTRY-scoped: a locality with no population keeps its honest zero.
			const [springfield] = probe(db, normalizeLocalityForKey("Springfield"))
			expect(springfield?.population).toBe(114_000)
		} finally {
			db.close()
		}
	})

	test("stamps name roles: the gloss anomaly core, prominence-rescued fame, and the abbr provenance signal (#1730)", async () => {
		const input = join(scratch, "admin.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)

		const src = new DatabaseSync(input)

		src.exec(`
			-- The gloss shape: a common-noun-named locality, NO population, NO importance, key volume over threshold.
			INSERT INTO spr VALUES (300, 'Poisson', 'locality', 'FR', 46.0, 4.0, 45.9, 3.9, 46.1, 4.1, -1, 0);
			INSERT INTO place_search VALUES (300, 'Fish${ALIAS_SEP}Fisch${ALIAS_SEP}Pesce${ALIAS_SEP}Vis');
			-- The rescue: same key volume, but MEASURED prominence (population) — a famous place's exonym set.
			INSERT INTO spr VALUES (301, 'Grandville', 'locality', 'FR', 47.0, 5.0, 46.9, 4.9, 47.1, 5.1, -1, 0);
			INSERT INTO place_population VALUES (301, 2100000);
			INSERT INTO place_search VALUES (301, 'Bigtown${ALIAS_SEP}Grossstadt${ALIAS_SEP}Grancitta${ALIAS_SEP}Grootstad');
			-- The abbr provenance signal: a variant name in the country's official language.
			CREATE TABLE names (
				id INTEGER NOT NULL, name TEXT NOT NULL, placetype TEXT NOT NULL DEFAULT '',
				country TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '',
				privateuse TEXT NOT NULL DEFAULT '', official INTEGER NOT NULL DEFAULT 0,
				lastmodified INTEGER NOT NULL DEFAULT 0
			);
			-- Chicago's variant in English (US official) — the stampable signal…
			INSERT INTO names VALUES (200, 'Chi-Town', 'locality', 'US', 'eng', 'variant', 0, 0);
			-- …a variant in a NON-official language stays unstamped…
			INSERT INTO names VALUES (200, 'Windy City', 'locality', 'US', 'jpn', 'variant', 0, 0);
			-- …and a preferred name never stamps, whatever its language.
			INSERT INTO names VALUES (202, 'St Etienne', 'locality', 'FR', 'fra', 'preferred', 0, 0);
		`)

		src.close()

		// Fixture-scale threshold: 5 staged keys (primary + 4 aliases) crosses it.
		await buildCandidateTable({ input, output, glossKeyThreshold: 5 })

		const db = new DatabaseSync(output, { readOnly: true })

		const role = (key: string): Array<{ name: string; role: string | null; primary: number }> =>
			db
				.prepare(`SELECT name, name_role AS role, is_primary AS "primary" FROM candidate WHERE name_key = ?`)
				.all(key) as never

		try {
			// Gloss core: every alias of the double-absent place stamps; its primary never does.
			expect(role("fish")[0]).toMatchObject({ role: "gloss" })
			expect(role("vis")[0]).toMatchObject({ role: "gloss" })
			expect(role("poisson")[0]).toMatchObject({ role: null, primary: 1 })

			// Prominence rescue: same key volume, measured population — no gloss stamp.
			expect(role("bigtown")[0]).toMatchObject({ role: null })

			// Abbr provenance: official-language variant stamps; non-official variant does not; the
			// preferred-name alias does not.
			expect(role(normalizeLocalityForKey("Chi-Town"))[0]).toMatchObject({ role: "abbr", primary: 0 })
			expect(role(normalizeLocalityForKey("Windy City"))[0]).toMatchObject({ role: null })
			expect(role(normalizeLocalityForKey("St Etienne"))[0]).toMatchObject({ role: null })
		} finally {
			db.close()
		}
	})

	test("keys diacritic names by their folded form — build/query parity by construction", async () => {
		const input = join(scratch, "admin.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)
		await buildCandidateTable({ input, output })

		const db = new DatabaseSync(output, { readOnly: true })

		try {
			// The query side normalizes the user's input the same way; "Saint-Étienne" → "saint-etienne".
			const key = normalizeLocalityForKey("Saint-Étienne")
			expect(key).toBe("saint-etienne")
			const [hit] = probe(db, key)
			expect(hit?.name).toBe("Saint-Étienne")
			expect(hit?.country).toBe("FR")
		} finally {
			db.close()
		}
	})

	test("explodes alt-name bags into resolvable alias rows pointing at the primary", async () => {
		const input = join(scratch, "admin.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)
		const result = await buildCandidateTable({ input, output })
		// Chicago: Chi-Town + Windy City; Saint-Étienne: St Etienne = 3 aliases.
		expect(result.aliases).toBe(3)

		const db = new DatabaseSync(output, { readOnly: true })

		try {
			const [windy] = probe(db, normalizeLocalityForKey("Windy City"))
			expect(windy?.name).toBe("Chicago") // alias row carries the primary's display name + coords
			expect(windy?.is_primary).toBe(0)
			expect(windy?.latitude).toBeCloseTo(41.88, 2)
		} finally {
			db.close()
		}
	})

	test("carries region abbreviations from place_abbr", async () => {
		const input = join(scratch, "admin.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)
		const result = await buildCandidateTable({ input, output })
		expect(result.abbrevs).toBe(1)

		const db = new DatabaseSync(output, { readOnly: true })

		try {
			const [il] = probe(db, normalizeLocalityForKey("IL"))
			expect(il?.name).toBe("Illinois")
			expect(il?.placetype).toBe("region")
		} finally {
			db.close()
		}
	})

	test("folds postcode shards in, dropping placeholder 0,0-coord rows", async () => {
		const input = join(scratch, "admin.db")
		const pc = join(scratch, "postcodes.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)
		buildFixturePostcodes(pc)

		const result = await buildCandidateTable({ input, output, postcodes: [pc] })
		// The real-coord 60601 + 11201 survive; the 0,0 placeholder 20500 is filtered.
		expect(result.postcodes).toBe(2)

		const db = new DatabaseSync(output, { readOnly: true })

		try {
			const [zip] = probe(db, normalizeLocalityForKey("60601"))
			expect(zip?.placetype).toBe("postalcode")
			expect(zip?.latitude).toBeCloseTo(41.885, 3)
			expect(probe(db, normalizeLocalityForKey("20500"))).toHaveLength(0)
		} finally {
			db.close()
		}
	})

	test("folds postcode delivery-city aliases into the exact tier (#1495)", async () => {
		const input = join(scratch, "admin.db")
		const pc = join(scratch, "postcodes.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)
		buildFixturePostcodes(pc)

		const result = await buildCandidateTable({ input, output, postcodes: [pc] })
		// Only "Brooklyn". The shard's own '11201' names row keys to the primary and is skipped, and
		// 'The White House' hangs off 20500, which the coord filter never staged.
		expect(result.postcodeAliases).toBe(1)

		const db = new DatabaseSync(output, { readOnly: true })

		try {
			// Before the fix this probe returned nothing: the delivery-city names reached
			// `place_search.alt_names` (FTS) but never the candidate table, where every row IS an
			// exact-tier row.
			const [brooklyn] = probe(db, normalizeLocalityForKey("Brooklyn"))
			expect(brooklyn).toBeDefined()
			expect(brooklyn!.placetype).toBe("postalcode")
			// The alias row is denormalized onto the POSTCODE — display name, coords and bbox are 11201's.
			expect(brooklyn!.name).toBe("11201")
			expect(brooklyn!.country).toBe("US")
			expect(brooklyn!.latitude).toBeCloseTo(40.694, 3)
			expect(brooklyn!.min_lat).toBeCloseTo(40.68, 2)
			// `is_primary = 0` — the rank/demotion contest must treat it as an alias, not a canonical
			// postcode name.
			expect(brooklyn!.is_primary).toBe(0)

			// The primary row is untouched by the new pass.
			const [zip] = probe(db, normalizeLocalityForKey("11201"))
			expect(zip?.is_primary).toBe(1)
			expect(zip?.name).toBe("11201")

			expect(probe(db, normalizeLocalityForKey("The White House"))).toHaveLength(0)
		} finally {
			db.close()
		}
	})

	test("a shard with no `names` table reports the absence instead of a silent zero", async () => {
		const input = join(scratch, "admin.db")
		const pc = join(scratch, "postcodes.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)
		buildFixturePostcodes(pc, false)

		const phases: string[] = []

		const result = await buildCandidateTable({
			input,
			output,
			postcodes: [pc],
			onProgress: (phase, message) => phases.push(`${phase}: ${message}`),
		})

		expect(result.postcodes).toBe(2)
		expect(result.postcodeAliases).toBe(0)
		// A magnitude never carries its own absence — 0 aliases from an unread table has to say so.
		expect(phases.some((p) => p.startsWith("postcode-aliases:") && p.includes("no `names` table"))).toBe(true)
	})

	test("materializes the output at page_size 8192 (the httpvfs chunk alignment)", async () => {
		const input = join(scratch, "admin.db")
		const output = join(scratch, "candidate.db")
		buildFixtureAdmin(input)
		await buildCandidateTable({ input, output })

		const db = new DatabaseSync(output, { readOnly: true })

		try {
			const { page_size } = db.prepare("PRAGMA page_size").get() as { page_size: number }
			expect(page_size).toBe(8192)
			// And the clustered table is WITHOUT ROWID (the rows ARE the B-tree).
			const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='candidate'").get() as { sql: string }).sql
			expect(sql).toMatch(/WITHOUT ROWID/i)
		} finally {
			db.close()
		}
	})

	describe("the importance column (#28)", () => {
		/**
		 * A score source whose ids share nothing with the admin fixture's — the join must work anyway. Chicago and
		 * Saint-Étienne are scored; Springfield deliberately is NOT (the unmeasured case).
		 */
		function buildFixtureImportance(path: string): void {
			const db = new DatabaseSync(path)

			db.exec(`
				CREATE TABLE spr (
					id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
					latitude REAL, longitude REAL, is_current INTEGER, is_deprecated INTEGER
				);
				CREATE TABLE place_importance (id INTEGER PRIMARY KEY, importance REAL NOT NULL);

				INSERT INTO spr VALUES (7000000000200, 'Chicago', 'locality', 'US', 41.88, -87.63, -1, 0);
				INSERT INTO spr VALUES (7000000000202, 'Saint-Étienne', 'locality', 'FR', 45.43, 4.39, -1, 0);
				-- Same name + country + placetype as the admin fixture's Springfield, but 1,500 km away:
				-- a DIFFERENT town, so the gate must refuse it rather than lend it the score.
				INSERT INTO spr VALUES (7000000000201, 'Springfield', 'locality', 'US', 42.10, -72.59, -1, 0);
				-- A postcode-shaped row: the shard fold must not pick it up either way.
				INSERT INTO spr VALUES (7000000060601, '60601', 'postalcode', 'US', 41.885, -87.62, -1, 0);

				INSERT INTO place_importance VALUES (7000000000200, 0.8125);
				INSERT INTO place_importance VALUES (7000000000202, 0.4400);
				INSERT INTO place_importance VALUES (7000000000201, 0.6126);
				INSERT INTO place_importance VALUES (7000000060601, 0.1000);
			`)

			db.close()
		}

		function importanceOf(db: DatabaseSync, key: string): Array<number | null> {
			return (
				db
					.prepare("SELECT importance FROM candidate WHERE name_key = ? ORDER BY neg_rank ASC")
					.all(key) as unknown as Array<{ importance: number | null }>
			).map((r) => r.importance)
		}

		test("joins the score onto the place, and onto its ALIAS rows too", async () => {
			const input = join(scratch, "admin.db")
			const importance = join(scratch, "importance.db")
			const output = join(scratch, "candidate.db")
			buildFixtureAdmin(input)
			buildFixtureImportance(importance)

			const result = await buildCandidateTable({ input, output, importance })
			expect(result.importanceScored).toBe(2) // Chicago + Saint-Étienne
			expect(result.importanceGated).toBe(1) // Springfield — same key, wrong town

			const db = new DatabaseSync(output, { readOnly: true })

			try {
				expect(importanceOf(db, normalizeLocalityForKey("Chicago"))).toEqual([0.8125])
				// The score is a property of the PLACE, so the alias rows carry it. This is what lets a bare
				// "Moscow" reach Москва's score through the alias row that holds the Latin key.
				expect(importanceOf(db, normalizeLocalityForKey("Chi-Town"))).toEqual([0.8125])
				expect(importanceOf(db, normalizeLocalityForKey("Windy City"))).toEqual([0.8125])
				// Folded key parity holds on the join too: "Saint-Étienne" scores through its folded form,
				// and its alias row inherits.
				expect(importanceOf(db, normalizeLocalityForKey("Saint-Étienne"))).toEqual([0.44])
				expect(importanceOf(db, normalizeLocalityForKey("St Etienne"))).toEqual([0.44])
			} finally {
				db.close()
			}
		})

		test("an unmatched place is NULL — unmeasured, never 0", async () => {
			const input = join(scratch, "admin.db")
			const importance = join(scratch, "importance.db")
			const output = join(scratch, "candidate.db")
			buildFixtureAdmin(input)
			buildFixtureImportance(importance)
			await buildCandidateTable({ input, output, importance })

			const db = new DatabaseSync(output, { readOnly: true })

			try {
				// Springfield's only same-key scored place is 1,500 km away — a different town. The gate
				// refuses it, and the refusal is recorded as ABSENCE, not as a zero a consumer could rank on.
				expect(importanceOf(db, normalizeLocalityForKey("Springfield"))).toEqual([null])
				// Illinois (region) and the US (country) were never scored at all.
				expect(importanceOf(db, normalizeLocalityForKey("Illinois"))).toEqual([null])
				expect(importanceOf(db, normalizeLocalityForKey("IL"))).toEqual([null])
			} finally {
				db.close()
			}
		})

		test("postcode rows are NULL even when the source carries a same-named row", async () => {
			const input = join(scratch, "admin.db")
			const pc = join(scratch, "postcodes.db")
			const importance = join(scratch, "importance.db")
			const output = join(scratch, "candidate.db")
			buildFixtureAdmin(input)
			buildFixturePostcodes(pc)
			buildFixtureImportance(importance)
			await buildCandidateTable({ input, output, postcodes: [pc], importance })

			const db = new DatabaseSync(output, { readOnly: true })

			try {
				// A postcode has no toponym fame; the score source's 60601 row must not leak onto it.
				expect(importanceOf(db, "60601")).toEqual([null])
				// …including the delivery-city alias hanging off the same postcode row.
				expect(importanceOf(db, normalizeLocalityForKey("Brooklyn"))).toEqual([null])
			} finally {
				db.close()
			}
		})

		test("without a score source the column exists and is empty — and the result says so", async () => {
			const input = join(scratch, "admin.db")
			const output = join(scratch, "candidate.db")
			buildFixtureAdmin(input)

			const result = await buildCandidateTable({ input, output })
			// `undefined`, not 0: the pass did not run. A 0 would claim the source matched nothing.
			expect(result.importanceScored).toBeUndefined()
			expect(result.importanceGated).toBeUndefined()

			const db = new DatabaseSync(output, { readOnly: true })

			try {
				const { n } = db.prepare("SELECT COUNT(*) AS n FROM candidate WHERE importance IS NOT NULL").get() as {
					n: number
				}

				expect(n).toBe(0)
			} finally {
				db.close()
			}
		})
	})
})

describe("stageCountryDisplayNames (#1678 thread 1)", () => {
	const GEORGIA_SID = 9_000_000_249_733
	const GE_CID = 7

	function attrsFor(overrides: Partial<PlaceAttrs> = {}): PlaceAttrs {
		return {
			cid: GE_CID,
			rid: 0,
			ptid: 1,
			name: "Georgia",
			lat: 42,
			lon: 43.5,
			mnLat: 41,
			mnLon: 40,
			mxLat: 43.6,
			mxLon: 46.7,
			pop: 3_700_000,
			neg: -Math.log10(3_700_001),
			pkey: "georgia",
			imp: null,
			...overrides,
		} as PlaceAttrs
	}

	function run(attrs: Map<number, PlaceAttrs>) {
		const staged: Array<{ key: string; sid: number; isPrimary: number; name: string }> = []

		const count = stageCountryDisplayNames({
			attrs,
			iso2ByID: new Map([[GE_CID, "GE"]]),
			countryPtID: 1,
			stageRow: (key, a, sid, isPrimary) => staged.push({ key, sid, isPrimary, name: a.name }),
			tx: { exec: () => {} },
		})

		return { count, staged }
	}

	test("stages the non-Latin surfaces the bare-toponym probe could not resolve", () => {
		const { staged } = run(new Map([[GEORGIA_SID, attrsFor()]]))
		const keys = staged.map((r) => r.key)

		// The exact strings that returned nothing on 2026-08-15.
		expect(keys).toContain("格鲁吉亚")
		expect(keys).toContain("喬治亞")
	})

	test("keeps the country's display name — a surface resolves TO Georgia, it does not rename it", () => {
		const { staged } = run(new Map([[GEORGIA_SID, attrsFor()]]))

		expect(staged.every((r) => r.name === "Georgia")).toBe(true)
		expect(staged.every((r) => r.sid === GEORGIA_SID)).toBe(true)
	})

	test("stages every surface as an alias, never a primary", () => {
		const { staged } = run(new Map([[GEORGIA_SID, attrsFor()]]))

		expect(staged.every((r) => r.isPrimary === 0)).toBe(true)
	})

	test("skips the self-alias so the primary key is not restaged", () => {
		const { staged } = run(new Map([[GEORGIA_SID, attrsFor()]]))

		expect(staged.map((r) => r.key)).not.toContain("georgia")
	})

	test("ignores non-country rows — a region carrying the same country code is not a target", () => {
		const { count } = run(new Map([[1, attrsFor({ ptid: 99, name: "Tbilisi" })]]))

		expect(count).toBe(0)
	})

	test("prefers the most populous row when a code has several", () => {
		const { staged } = run(
			new Map([
				[GEORGIA_SID, attrsFor({ pop: 3_700_000 })],
				[1, attrsFor({ pop: 12, name: "Georgia (historic)" })],
			])
		)

		expect(staged.every((r) => r.sid === GEORGIA_SID)).toBe(true)
	})
})
