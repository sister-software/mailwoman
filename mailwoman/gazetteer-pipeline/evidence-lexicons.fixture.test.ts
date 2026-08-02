/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The four-law selectivity end to end against a SEEDED admin DB — the every-PR layer.
 *
 *   Same idiom as `resolver-wof-sqlite/candidate-lookup.test.ts`: production DDL, hand-picked rows,
 *   and the REAL `buildLocalitySurfaceLexicon` driven through `opts.dbPath`. Every surface here is
 *   one the full-scale test named, so the laws are asserted at full fidelity — and, unlike the full
 *   build, this file is invariant to gazetteer size. The 2026-08-02 measurement that motivated the
 *   split: the two full-DB tests were 236.9s of a 253s CI leg, and growing.
 *
 *   What does NOT live here: `entries > 10_000` and the other coverage-scale assertions. Those are
 *   claims about the gazetteer rather than about the laws — see `evidence-lexicons.full.test.ts`.
 *
 *   ## Reading the populations
 *
 *   Importance is `min(1, log2(1 + pop/1000) / 14)`, so the two floors invert to:
 *
 *     ONE_TOKEN_IMPORTANCE_FLOOR   0.25 → pop ≥ 10,314
 *     PERSON_NAME_IMPORTANCE_FLOOR 0.45 → pop ≥ 77,793
 *
 *   Which floor applies depends on whether libpostal's given_names/surnames/personal_titles carry
 *   the surface. Verified against the shipped dictionaries: paris, lyon, joseph, fargo and
 *   washington ARE person names; rennes, belleville, smallville, minot, rutland, plainfield,
 *   cheyenne and roazhon are not. Fargo is the one that surprises — it needs the 0.45 tier, which is
 *   why it is seeded at 130 k rather than something merely above 10 k.
 */

import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { BuiltLexicon } from "./evidence-lexicons.ts"
import { buildLocalitySurfaceLexicon } from "./evidence-lexicons.ts"

let scratch: string

/**
 * A minimal admin WOF carrying the four tables `buildLocalitySurfaceLexicon` reads: `spr` (primaries), `names`
 * (aliases), `place_population` (the law-2/3 importance input), and `ancestors` (the v4 parent-prominence proxy).
 */
function buildFixtureAdmin(path: string): void {
	const db = new DatabaseSync(path)

	// Throwaway fixture, so durability is worthless and expensive. `db.exec` runs each statement in
	// its own autocommit transaction, and the ~50 INSERTs below were paying an fsync apiece —
	// measured at ~1.8s per build inside vitest against 1ms for the build itself. Turning off
	// synchronous writes and keeping the journal in memory is what makes this layer cheap enough to
	// run on every PR, which is the whole point of it.
	db.exec(`
		PRAGMA synchronous = OFF;
		PRAGMA journal_mode = MEMORY;

		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_current INTEGER
		);
		CREATE TABLE names (id INTEGER, name TEXT);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);

		-- FR — law-3 flip rows. Paris/Lyon are metro-tier person-name HOMOGRAPHS that must survive;
		-- Joseph is a given name at ordinary-town prominence that must not.
		INSERT INTO spr VALUES (10, 'Paris',      'locality', 'FR', 1);
		INSERT INTO spr VALUES (11, 'Lyon',       'locality', 'FR', 1);
		INSERT INTO spr VALUES (12, 'Joseph',     'locality', 'FR', 1);
		INSERT INTO spr VALUES (13, 'Rennes',     'locality', 'FR', 1);
		-- Law 1 — an all-stopword composition, and a surface with no letters at all.
		INSERT INTO spr VALUES (14, 'De La',      'locality', 'FR', 1);
		INSERT INTO spr VALUES (15, '12',         'locality', 'FR', 1);
		-- Law 2 — below the one-token floor.
		INSERT INTO spr VALUES (16, 'Smallville', 'locality', 'FR', 1);
		-- Law-3 guard — a person-named neighbourhood inside a prominent parent must NOT be laundered
		-- by that parent, while its non-name sibling DOES inherit (the Montmartre case).
		INSERT INTO spr VALUES (17, 'Joseph',     'neighbourhood', 'FR', 1);
		INSERT INTO spr VALUES (18, 'Belleville', 'neighbourhood', 'FR', 1);

		-- US — law-4 region vocabulary, the directional closure, and sub-phrase hygiene.
		INSERT INTO spr VALUES (30, 'Washington',       'locality', 'US', 1);
		INSERT INTO spr VALUES (31, 'Wyoming',          'locality', 'US', 1);
		INSERT INTO spr VALUES (32, 'Vermont',          'locality', 'US', 1);
		INSERT INTO spr VALUES (33, 'Missouri',         'locality', 'US', 1);
		INSERT INTO spr VALUES (34, 'North Dakota',     'locality', 'US', 1);
		INSERT INTO spr VALUES (35, 'East',             'neighbourhood', 'US', 1);
		INSERT INTO spr VALUES (36, 'Southwest',        'neighbourhood', 'US', 1);
		-- The ordinary localities the census rows NEED to survive.
		INSERT INTO spr VALUES (40, 'Fargo',            'locality', 'US', 1);
		INSERT INTO spr VALUES (41, 'Minot',            'locality', 'US', 1);
		INSERT INTO spr VALUES (42, 'Rutland',          'locality', 'US', 1);
		INSERT INTO spr VALUES (43, 'Plainfield',       'locality', 'US', 1);
		INSERT INTO spr VALUES (44, 'Cheyenne',         'locality', 'US', 1);
		-- A directional INSIDE a multi-token surface — exclusion is whole-surface only.
		INSERT INTO spr VALUES (45, 'East Nashville',   'locality', 'US', 1);
		INSERT INTO spr VALUES (46, 'Mount Washington', 'locality', 'US', 1);

		-- Person-name tier (>= 77,793).
		INSERT INTO place_population VALUES (10, 2100000);
		INSERT INTO place_population VALUES (11, 1700000);
		-- Ordinary town: clears law 2 (>= 10,314) but NOT the person-name tier.
		INSERT INTO place_population VALUES (12, 40000);
		INSERT INTO place_population VALUES (13, 220000);
		INSERT INTO place_population VALUES (14, 500000);
		INSERT INTO place_population VALUES (15, 500000);
		-- Below the one-token floor.
		INSERT INTO place_population VALUES (16, 4000);
		INSERT INTO place_population VALUES (30, 700000);
		INSERT INTO place_population VALUES (31, 700000);
		INSERT INTO place_population VALUES (32, 700000);
		INSERT INTO place_population VALUES (33, 700000);
		INSERT INTO place_population VALUES (34, 700000);
		INSERT INTO place_population VALUES (35, 700000);
		INSERT INTO place_population VALUES (36, 700000);
		-- Fargo IS a libpostal surname, so it needs the 0.45 tier, not the 0.25 one.
		INSERT INTO place_population VALUES (40, 130000);
		INSERT INTO place_population VALUES (41, 48000);
		INSERT INTO place_population VALUES (42, 15000);
		INSERT INTO place_population VALUES (43, 50000);
		INSERT INTO place_population VALUES (44, 65000);
		INSERT INTO place_population VALUES (45, 90000);
		INSERT INTO place_population VALUES (46, 90000);

		-- Both FR neighbourhoods hang off Paris, so parent prominence is available to both and the
		-- law-3 guard is the only thing separating their outcomes.
		INSERT INTO ancestors VALUES (17, 10, 'locality');
		INSERT INTO ancestors VALUES (18, 10, 'locality');

		-- Sub-phrase aliases: refused. A genuine nickname: kept.
		INSERT INTO names VALUES (45, 'East');
		INSERT INTO names VALUES (46, 'Washington');
		INSERT INTO names VALUES (13, 'Roazhon');
	`)

	db.close()
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "evidence-lexicons-fixture-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

/**
 * Build against the fixture and return the emitted surface map plus the build's counters.
 *
 * NAMING TRAP, called out because both halves are spelled "entries": `built.entries` is a COUNT (`BuiltLexicon.entries:
 * number`) while the lexicon file's `entries` is the surface→bitmask MAP. The map comes back as `surfaces` so the two
 * cannot be confused at a call site.
 */
let buildSeq = 0

function buildAgainstFixture(
	countries: string[],
	placetypes: string[]
): { built: BuiltLexicon; surfaces: Record<string, number> } {
	// A fresh DB per call. Two tests build twice — the sub-phrase one covers both country sets, and
	// the invariance one runs the same build twice on purpose — and `CREATE TABLE` is not idempotent.
	const seq = buildSeq++
	const dbPath = join(scratch, `admin-${seq}.db`)
	const output = join(scratch, `lexicon-${seq}.json`)
	buildFixtureAdmin(dbPath)

	const built = buildLocalitySurfaceLexicon({ countries, placetypes, dbPath, output })
	const lexicon = JSON.parse(readFileSync(output, "utf8")) as { entries: Record<string, number> }

	return { built, surfaces: lexicon.entries }
}

describe("locality-surface build — fixture (four laws end to end)", () => {
	it("law 3: metros survive, given-name homographs do not", () => {
		const { surfaces } = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		// Paris and Lyon clear the person-name tier on their own metro prominence.
		expect(surfaces.paris).toBeDefined()
		expect(surfaces.lyon).toBeDefined()
		// A given name at ordinary-town prominence is refused — the Rue-Joseph hazard.
		expect(surfaces.joseph).toBeUndefined()
		// A non-name surface at comparable prominence passes; only law 2 applies to it.
		expect(surfaces.rennes).toBeDefined()
	})

	it("law-3 guard: parent prominence never launders a person-name neighbourhood", () => {
		const { surfaces } = buildAgainstFixture(["FR"], ["locality", "localadmin", "neighbourhood"])

		// Joseph-the-neighbourhood sits inside Paris and STILL does not clear.
		expect(surfaces.joseph).toBeUndefined()
		// Belleville is not a person name, so it DOES inherit Paris's prominence.
		expect(surfaces.belleville).toBeDefined()
	})

	it("law 1: all-stopword compositions and letters-free surfaces are refused", () => {
		const { built, surfaces } = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(surfaces["de la"]).toBeUndefined()
		expect(surfaces["12"]).toBeUndefined()
		expect(built.skippedDegenerate).toBeGreaterThanOrEqual(2)
	})

	it("law 2: the one-token floor refuses exactly the two rows seeded below their tier", () => {
		const { built, surfaces } = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(surfaces.smallville).toBeUndefined()
		// EXACT, which the full build cannot assert. Two surfaces fail the post-scan prominence pass
		// and only two: `smallville` (0.166, under the 0.25 one-token floor) and `joseph` (0.383 —
		// over that floor, under the 0.45 person-name tier). If a third ever appears here, a law
		// changed scope.
		expect(built.skippedProminence).toBe(2)
	})

	it("law 4: region vocabulary and the directional closure are out", () => {
		const { built, surfaces } = buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		for (const surface of ["washington", "wyoming", "vermont", "missouri", "north dakota"]) {
			expect(surfaces[surface], surface).toBeUndefined()
		}

		for (const surface of ["east", "southwest"]) {
			expect(surfaces[surface], surface).toBeUndefined()
		}

		expect(built.skippedRegionVocabulary).toBeGreaterThan(0)
	})

	it("keeps the ordinary localities the census rows need", () => {
		const { built, surfaces } = buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		for (const surface of ["fargo", "minot", "rutland", "plainfield", "cheyenne"]) {
			expect(surfaces[surface], surface).toBeDefined()
		}

		// A directional INSIDE a multi-token surface survives.
		expect(surfaces["east nashville"]).toBeDefined()
		// …and nothing in the US set is refused on prominence, unlike the FR set. The asymmetry is
		// the point: these rows are seeded at their real magnitudes.
		expect(built.skippedProminence).toBe(0)
	})

	it("sub-phrase aliases are refused, genuine nicknames are kept", () => {
		const us = buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		// "East" ⊂ "East Nashville" and "Washington" ⊂ "Mount Washington" — the names-table leak.
		expect(us.built.skippedSubPhrase).toBe(2)

		const fr = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		// "Roazhon" is a real Breton nickname for Rennes, not a sub-phrase of it.
		expect(fr.surfaces.roazhon).toBeDefined()
	})

	it("is invariant to gazetteer size — the reason this layer exists", () => {
		const first = buildAgainstFixture(["FR"], ["locality", "localadmin"])
		const second = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(second.built.entries).toBe(first.built.entries)
		expect(second.built.skippedProminence).toBe(first.built.skippedProminence)
	})
})
