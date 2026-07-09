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
 *   4. **The four passes** — primaries, alias bags, region abbreviations, and postcode shards (with the
 *        `latitude!=0 AND longitude!=0` placeholder-coord filter).
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildCandidateTable } from "./build-candidate.ts"
import { normalizeLocalityForKey } from "./street-normalize.ts"

const ALIAS_SEP = "\u{E000}"

let scratch: string

/** A minimal admin WOF with the tables `buildCandidateTable` reads. */
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

/** A postcode shard: `spr` with placetype='postalcode'. One real-coord ZIP + one placeholder 0,0. */
function buildFixturePostcodes(path: string): void {
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
	`)
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
}

/** Resolve a normalized key the way the query side does — join the code maps back to strings. */
function probe(db: DatabaseSync, key: string): CandRow[] {
	return db
		.prepare(
			`SELECT c.name_key, c.name, cc.code AS country, pc.placetype AS placetype,
				c.latitude, c.longitude, c.min_lat, c.is_primary
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
			expect(chi.name).toBe("Chicago")
			expect(chi.country).toBe("US")
			expect(chi.placetype).toBe("locality")
			expect(chi.latitude).toBeCloseTo(41.88, 2)
			expect(chi.min_lat).toBeCloseTo(41.6, 2)
			expect(chi.is_primary).toBe(1)

			// Deprecated row must not resolve.
			expect(probe(db, normalizeLocalityForKey("Old Town"))).toHaveLength(0)
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
		// Only the real-coord 60601 survives; the 0,0 placeholder 20500 is filtered.
		expect(result.postcodes).toBe(1)

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
})
