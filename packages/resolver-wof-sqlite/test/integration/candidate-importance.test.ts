/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link loadImportanceIndex} / {@link ImportanceIndex} — the name-keyed, geographically
 *   disambiguated join that fills the candidate gazetteer's `importance` column (#28).
 *
 *   The fixture is built around the two failure modes the join exists to avoid, both taken from the
 *   live artifacts:
 *
 *   1. **The id disagreement.** `candidate.db` and the score source key Whitby, Ontario differently
 *        (`8143502164401` vs `8000001156384`), so an id join drops it — and dropping the foreign
 *        homonym is exactly the outcome the fame prior exists to prevent. Every fixture place here
 *        carries a DIFFERENT id on the two sides, so an id join would score nothing at all.
 *   2. **Same-name fan-out.** One country holds many places of one name. The join must give each its
 *        own score rather than the group's best, and must refuse a same-name place that is simply
 *        somewhere else.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { IMPORTANCE_JOIN_GATE_KM, loadImportanceIndex } from "@mailwoman/resolver-wof-sqlite/candidate-importance"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

let scratch: TemporaryDirectory
let sourcePath: string

/**
 * A score source in the shape `admin-global-priority-importance.db` has: `spr` + `place_importance`.
 *
 * Ids here are deliberately NOTHING like the ids a candidate build would carry — the join must not depend on them.
 */
function buildFixtureSource(path: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE place_importance (id INTEGER PRIMARY KEY, importance REAL NOT NULL);

		-- The bare-GB case: one name, two countries, the SMALLER place scoring higher.
		INSERT INTO spr VALUES (9000000000001, 'Whitby', 'locality', 'GB', 54.4858, -0.6206, -1, 0);
		INSERT INTO spr VALUES (9000000000002, 'Whitby', 'locality', 'CA', 43.8975, -78.9428, -1, 0);

		-- Same-name fan-out inside one country: three Warwicks, ~1,000 km apart, different scores.
		INSERT INTO spr VALUES (9000000000003, 'Warwick', 'locality', 'US', 41.7001, -71.4162, -1, 0);
		INSERT INTO spr VALUES (9000000000004, 'Warwick', 'locality', 'US', 33.2137, -83.9224, -1, 0);

		-- Diacritics + non-Latin: the join key is the SHARED fold, so these must reach their scores.
		INSERT INTO spr VALUES (9000000000005, 'Zürich', 'locality', 'CH', 47.3769, 8.5417, -1, 0);
		INSERT INTO spr VALUES (9000000000006, 'Москва', 'locality', 'RU', 55.7558, 37.6173, -1, 0);

		-- Placetype is part of the key: a REGION named Windsor must not hand its score to a LOCALITY.
		INSERT INTO spr VALUES (9000000000007, 'Windsor', 'region', 'GB', 51.4816, -0.6095, -1, 0);

		-- A DEPRECATED row sitting on top of a live place: its score must never be reachable.
		INSERT INTO spr VALUES (9000000000008, 'Ghosttown', 'locality', 'US', 40.0, -100.0, 1, 1);

		-- A name that folds to the empty key — counted, never indexed.
		INSERT INTO spr VALUES (9000000000009, '.', 'locality', 'US', 10.0, 10.0, -1, 0);

		INSERT INTO place_importance VALUES (9000000000001, 0.5496);
		INSERT INTO place_importance VALUES (9000000000002, 0.5089);
		INSERT INTO place_importance VALUES (9000000000003, 0.5055);
		INSERT INTO place_importance VALUES (9000000000004, 0.3729);
		INSERT INTO place_importance VALUES (9000000000005, 0.6216);
		INSERT INTO place_importance VALUES (9000000000006, 0.9530);
		INSERT INTO place_importance VALUES (9000000000007, 0.7000);
		INSERT INTO place_importance VALUES (9000000000008, 0.4000);
		INSERT INTO place_importance VALUES (9000000000009, 0.4000);
	`)
}

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-candidate-importance-")
	sourcePath = scratch.resolve("importance.db")
	buildFixtureSource(sourcePath)
})

afterEach(async () => {
	scratch[Symbol.asyncDispose]()
})

describe("loadImportanceIndex", () => {
	test("indexes current places only, and counts the unkeyable rather than dropping them silently", () => {
		const index = loadImportanceIndex(sourcePath)

		// 9 source rows: 1 deprecated (excluded by the query), 1 unkeyable (counted, not indexed).
		expect(index.stats.places).toBe(7)
		expect(index.stats.unkeyable).toBe(1)
		expect(index.stats.keys).toBe(6) // the two US Warwicks share one key
	})

	test("a deprecated place's score is unreachable", () => {
		const index = loadImportanceIndex(sourcePath)
		expect(index.find("Ghosttown", "US", "locality", 40, -100)).toBeNull()
	})
})

describe("ImportanceIndex.find", () => {
	test("scores a place whose id the two artifacts DISAGREE about (the whole reason the join is by name)", () => {
		const index = loadImportanceIndex(sourcePath)

		// The candidate side's Whitby rows carry unrelated ids; only name + country + placetype + position
		// are used, so both bearers score — including the foreign homonym the ranking exists to demote.
		expect(index.find("Whitby", "GB", "locality", 54.4796, -0.6251)).toBeCloseTo(0.5496, 4)
		expect(index.find("Whitby", "CA", "locality", 43.8975, -78.9428)).toBeCloseTo(0.5089, 4)
	})

	test("same-name fan-out resolves GEOGRAPHICALLY — each bearer gets its own score, not the group's best", () => {
		const index = loadImportanceIndex(sourcePath)

		expect(index.find("Warwick", "US", "locality", 41.7001, -71.4162)).toBeCloseTo(0.5055, 4)
		// The Georgia one must NOT inherit Rhode Island's 0.5055 — that is the fan-out defect.
		expect(index.find("Warwick", "US", "locality", 33.2137, -83.9224)).toBeCloseTo(0.3729, 4)
	})

	test("a same-name place beyond the gate is refused, not scored", () => {
		const index = loadImportanceIndex(sourcePath)

		// A third US Warwick nowhere near either scored one: the nearest same-key place is ~1,000 km off,
		// which is a different town. NULL, and counted as refused.
		expect(index.find("Warwick", "US", "locality", 60, -150)).toBeNull()
		expect(index.gated).toBe(1)
		expect(index.matched).toBe(0)
	})

	test("the gate admits a re-centroided match and refuses one just past it", () => {
		const index = loadImportanceIndex(sourcePath)

		// ~0.5 degrees of latitude ≈ 55 km — outside. ~0.05 ≈ 5.6 km — inside.
		expect(index.find("Zürich", "CH", "locality", 47.3769 + 0.05, 8.5417)).toBeCloseTo(0.6216, 4)
		expect(index.find("Zürich", "CH", "locality", 47.3769 + 0.5, 8.5417)).toBeNull()
		// Sanity on the constant the two cases straddle.
		expect(IMPORTANCE_JOIN_GATE_KM).toBeGreaterThan(5.6)
		expect(IMPORTANCE_JOIN_GATE_KM).toBeLessThan(55)
	})

	test("the key is the SHARED fold — diacritics and non-Latin scripts reach their scores", () => {
		const index = loadImportanceIndex(sourcePath)

		// "Zurich" and "Zürich" fold to the same key; Cyrillic survives the fold intact.
		expect(index.find("Zurich", "CH", "locality", 47.3769, 8.5417)).toBeCloseTo(0.6216, 4)
		expect(index.find("Москва", "RU", "locality", 55.7558, 37.6173)).toBeCloseTo(0.953, 4)
	})

	test("placetype is part of the key — a region does not lend its score to a locality", () => {
		const index = loadImportanceIndex(sourcePath)

		expect(index.find("Windsor", "GB", "region", 51.4816, -0.6095)).toBeCloseTo(0.7, 4)
		expect(index.find("Windsor", "GB", "locality", 51.4816, -0.6095)).toBeNull()
	})

	test("country is part of the key, and an unknown name is null (never 0)", () => {
		const index = loadImportanceIndex(sourcePath)

		expect(index.find("Whitby", "US", "locality", 54.4796, -0.6251)).toBeNull()
		expect(index.find("Nowhereton", "US", "locality", 0, 0)).toBeNull()
		// An empty-folding name can't be keyed either — and must not throw.
		expect(index.find("  ", "US", "locality", 0, 0)).toBeNull()
	})
})
