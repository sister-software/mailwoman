/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Importance is `min(1, log2(1 + pop/1000) / 14)`, so `ONE_TOKEN_IMPORTANCE_FLOOR` inverts to
 *   pop ≥ 10,314 and `PERSON_NAME_IMPORTANCE_FLOOR` to pop ≥ 77,793. Which floor applies depends on
 *   whether libpostal classifies the surface as a person name.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { BuiltLexicon } from "#gazetteer/evidence-lexicons"
import { buildLocalitySurfaceLexicon } from "#gazetteer/evidence-lexicons"

let scratch: TemporaryDirectory

function buildFixtureAdmin(path: PathBuilderLike): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	// Durability is worthless in a throwaway fixture.
	// The autocommit PRAGMAs are what keep this layer cheap enough to run on every PR.
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
}

beforeEach(async () => {
	scratch = await temporaryDirectory("evidence-lexicons-fixture-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

/**
 * Both halves are spelled `entries` — `built.entries` is a count while the lexicon file's `entries` is
 * the surface→bitmask map — so the map comes back as `surfaces` rather than a second `entries`.
 */
let buildSeq = 0

async function buildAgainstFixture(
	countries: string[],
	placetypes: string[]
): Promise<{ built: BuiltLexicon; surfaces: Record<string, number> }> {
	// A fresh DB per call, because `create table` is not idempotent and two tests build twice.
	const seq = buildSeq++
	const dbPath = scratch.path(`admin-${seq}.db`)
	const output = scratch.path(`lexicon-${seq}.json`)
	buildFixtureAdmin(dbPath)

	const built = await buildLocalitySurfaceLexicon({ countries, placetypes, dbPath, output })
	const lexicon = await readLocalJSONFile<{ entries: Record<string, number> }>(output)

	return { built, surfaces: lexicon.entries }
}

describe("locality-surface build — fixture (four laws end to end)", () => {
	it("law 3: metros survive, given-name homographs do not", async () => {
		const { surfaces } = await buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(surfaces.paris).toBeDefined()
		expect(surfaces.lyon).toBeDefined()
		expect(surfaces.joseph).toBeUndefined()
		expect(surfaces.rennes).toBeDefined()
	})

	it("law-3 guard: parent prominence never launders a person-name neighbourhood", async () => {
		const { surfaces } = await buildAgainstFixture(["FR"], ["locality", "localadmin", "neighbourhood"])

		expect(surfaces.joseph).toBeUndefined()
		expect(surfaces.belleville).toBeDefined()
	})

	it("law 1: all-stopword compositions and letters-free surfaces are refused", async () => {
		const { built, surfaces } = await buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(surfaces["de la"]).toBeUndefined()
		expect(surfaces["12"]).toBeUndefined()
		expect(built.skippedDegenerate).toBeGreaterThanOrEqual(2)
	})

	it("law 2: the one-token floor refuses exactly the two rows seeded below their tier", async () => {
		const { built, surfaces } = await buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(surfaces.smallville).toBeUndefined()
		// Only `smallville` (under the 0.25 floor) and `joseph` (over it but under the 0.45 person-name tier)
		// fail, so a third here means a law changed scope.
		expect(built.skippedProminence).toBe(2)
	})

	it("law 4: region vocabulary and the directional closure are out", async () => {
		const { built, surfaces } = await buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		for (const surface of ["washington", "wyoming", "vermont", "missouri", "north dakota"]) {
			expect(surfaces[surface], surface).toBeUndefined()
		}

		for (const surface of ["east", "southwest"]) {
			expect(surfaces[surface], surface).toBeUndefined()
		}

		expect(built.skippedRegionVocabulary).toBeGreaterThan(0)
	})

	it("keeps the ordinary localities the census rows need", async () => {
		const { built, surfaces } = await buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		for (const surface of ["fargo", "minot", "rutland", "plainfield", "cheyenne"]) {
			expect(surfaces[surface], surface).toBeDefined()
		}

		expect(surfaces["east nashville"]).toBeDefined()
		// No US row is refused on prominence, unlike the FR set, because these rows
		// are seeded at their real magnitudes.
		expect(built.skippedProminence).toBe(0)
	})

	it("sub-phrase aliases are refused, genuine nicknames are kept", async () => {
		const us = await buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		// "East" ⊂ "East Nashville" and "Washington" ⊂ "Mount Washington" — the names-table leak.
		expect(us.built.skippedSubPhrase).toBe(2)

		const fr = await buildAgainstFixture(["FR"], ["locality", "localadmin"])

		// "Roazhon" is a real Breton nickname for Rennes rather than a sub-phrase of it.
		expect(fr.surfaces.roazhon).toBeDefined()
	})

	it("is invariant to gazetteer size — the reason this layer exists", async () => {
		const first = await buildAgainstFixture(["FR"], ["locality", "localadmin"])
		const second = await buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(second.built.entries).toBe(first.built.entries)
		expect(second.built.skippedProminence).toBe(first.built.skippedProminence)
	})
})
