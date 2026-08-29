/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-score split's contract (ROAD_TO_V9 §2 R1): the referential derivation, the ordering
 *   equivalence that makes the split a zero-delta change for the resolver, and the legacy
 *   reconstruction the read-only 2026-08-05 staging database needs.
 */

import {
	compareReferential,
	createPlaceImportanceTable,
	IMPORTANCE_SPLIT_SOURCES,
	loadImportanceSplit,
	type PlaceImportanceDatabase,
	REFERENTIAL_SATURATION_POPULATION,
	referentialFromPopulation,
	splitLegacyImportance,
} from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

describe("referentialFromPopulation", () => {
	it("reproduces the FST builder's population fallback exactly", () => {
		// The formula the shipped fst-per-locale binaries were built with. Any drift here changes every
		// decode bias in the gazetteer, so it is pinned against the literal expression, not a constant.
		for (const pop of [1, 418, 1000, 96_128, 171_589, 472_465, 8_336_817]) {
			expect(referentialFromPopulation(pop)).toBe(Math.min(1, Math.log2(1 + pop / 1000) / 14))
		}
	})

	it("treats absent and zero population as no evidence, never as a penalty", () => {
		expect(referentialFromPopulation(undefined)).toBe(0)
		expect(referentialFromPopulation(null)).toBe(0)
		expect(referentialFromPopulation(0)).toBe(0)
		expect(referentialFromPopulation(-5)).toBe(0)
	})

	it("saturates at exactly 1.0 at the declared population", () => {
		expect(referentialFromPopulation(REFERENTIAL_SATURATION_POPULATION)).toBe(1)
		expect(referentialFromPopulation(REFERENTIAL_SATURATION_POPULATION * 3)).toBe(1)
		expect(referentialFromPopulation(REFERENTIAL_SATURATION_POPULATION - 1000)).toBeLessThan(1)
	})

	it("is strictly increasing below saturation", () => {
		let previous = -1

		for (let pop = 1; pop < REFERENTIAL_SATURATION_POPULATION; pop = Math.ceil(pop * 1.7)) {
			const score = referentialFromPopulation(pop)
			expect(score).toBeGreaterThan(previous)
			previous = score
		}
	})
})

describe("compareReferential — the zero-delta guarantee", () => {
	/**
	 * The whole D-rule claim for the resolver half of §2 R1: ordering by referential must be the SAME ORDER as ordering
	 * by population, on every input including the saturated tail. A bare `b.referential - a.referential` would not be —
	 * that is precisely the bug the population tiebreak exists to prevent.
	 */
	it("orders identically to raw population, saturated megacities included", () => {
		const populations = [
			0,
			1,
			52,
			418,
			2788,
			96_128,
			112_000,
			171_589,
			472_465,
			547_627,
			8_336_817,
			REFERENTIAL_SATURATION_POPULATION,
			20_000_000,
			32_900_000,
			37_400_000,
		]

		const rows = populations.map((population) => ({
			population,
			referential: referentialFromPopulation(population),
		}))

		const byReferential = rows.toSorted(compareReferential).map((r) => r.population)
		const byPopulation = rows.toSorted((a, b) => b.population - a.population).map((r) => r.population)

		expect(byReferential).toEqual(byPopulation)
	})

	it("a referential-only comparator DOES lose the megacity order — the reason for the tiebreak", () => {
		const rows = [
			{ population: 32_900_000, referential: referentialFromPopulation(32_900_000) },
			{ population: 37_400_000, referential: referentialFromPopulation(37_400_000) },
		]

		expect(rows[0]!.referential).toBe(rows[1]!.referential)
		expect(compareReferential(rows[1]!, rows[0]!)).toBeLessThan(0)
	})

	it("takes no encyclopedic input at all", () => {
		// Ranking on encyclopedic is what §2 forbids; the comparator cannot express it.
		const aude = { population: 418, referential: referentialFromPopulation(418), encyclopedic: 0.5683 }
		const suburb = { population: 96_128, referential: referentialFromPopulation(96_128), encyclopedic: 0.1173 }

		expect(compareReferential(suburb, aude)).toBeLessThan(0)
	})
})

describe("splitLegacyImportance", () => {
	it("attributes a bit-equal value to the population fallback", () => {
		const population = 418
		const legacy = referentialFromPopulation(population)

		expect(splitLegacyImportance(legacy, population)).toEqual({ referential: legacy })
	})

	it("attributes a value one ULP off the curve to the fallback — the cross-runtime log2 case", () => {
		// MEASURED (2026-08-06): CPython's math.log2 and V8's Math.log2 disagree by one ULP on 33,542 of
		// the 1.5 M rows in the 2026-08-05 build. wof 85803233, population 21,299: stored
		// 0.31992193633838988953, CPython 0.31992193633838994504. A bit-equality rule would have called
		// all 33,542 of them Wikipedia scores in any runtime but the one that wrote them.
		const population = 21_299
		const oneULPOff = referentialFromPopulation(population) + 5.55e-17

		expect(oneULPOff).not.toBe(referentialFromPopulation(population))
		expect(splitLegacyImportance(oneULPOff, population).encyclopedic).toBeUndefined()
	})

	it("still separates a real Wikipedia score that is merely SMALL", () => {
		// The tolerance must not become a bucket. A genuine low score sits many orders of magnitude
		// outside 8 ULP of the population curve.
		const population = 21_299
		const nearby = referentialFromPopulation(population) + 1e-6

		expect(splitLegacyImportance(nearby, population).encyclopedic).toBe(nearby)
	})

	it("attributes anything else to Wikipedia and keeps referential population-derived", () => {
		const split = splitLegacyImportance(0.5683, 418)

		expect(split.encyclopedic).toBe(0.5683)
		expect(split.referential).toBe(referentialFromPopulation(418))
	})

	it("keeps a Wikipedia score on a place with no population row", () => {
		expect(splitLegacyImportance(0.42, undefined)).toEqual({ referential: 0, encyclopedic: 0.42 })
	})

	it("never invents an encyclopedic score for a place absent from the legacy table", () => {
		expect(splitLegacyImportance(undefined, 96_128)).toEqual({ referential: referentialFromPopulation(96_128) })
	})
})

//#region loadImportanceSplit

function seedPopulation(db: DatabaseClient<PlaceImportanceDatabase>, rows: ReadonlyArray<[number, number]>): void {
	db.exec("CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0)")
	const insert = db.prepare("INSERT INTO place_population (id, population) VALUES (?, ?)")

	for (const [id, population] of rows) {
		insert.run(id, population)
	}
}

describe("loadImportanceSplit", () => {
	it("reads the split columns verbatim when they exist", async () => {
		await using kdb = new DatabaseClient<PlaceImportanceDatabase>(":memory:")
		seedPopulation(kdb, [[1, 96_128]])

		await createPlaceImportanceTable(kdb)

		kdb
			.prepare("INSERT INTO place_importance (id, referential, encyclopedic, importance) VALUES (?, ?, ?, ?)")
			.run(1, 0.25, 0.1173, 0.1173)

		kdb
			.prepare("INSERT INTO place_importance (id, referential, encyclopedic, importance) VALUES (?, ?, ?, ?)")
			.run(2, 0.5, null, 0.5)

		const split = loadImportanceSplit(kdb)

		expect(split.source).toBe(IMPORTANCE_SPLIT_SOURCES.splitColumns)
		expect(split.referential.get(1)).toBe(0.25)
		expect(split.encyclopedic.get(1)).toBe(0.1173)
		// NULL encyclopedic is ABSENT, not 0.
		expect(split.encyclopedic.has(2)).toBe(false)
	})

	it("reconstructs the split from a legacy conflated table", () => {
		using db = new DatabaseClient<PlaceImportanceDatabase>(":memory:")

		seedPopulation(db, [
			[1, 418],
			[2, 96_128],
			[3, 2788],
		])

		db.exec("CREATE TABLE place_importance (id INTEGER PRIMARY KEY, importance REAL NOT NULL)")
		const insert = db.prepare("INSERT INTO place_importance (id, importance) VALUES (?, ?)")
		// 1 + 2: Wikipedia rows (the Saint-Denis pair). 3: a population-fallback row.
		insert.run(1, 0.5683)
		insert.run(2, 0.1173)
		insert.run(3, referentialFromPopulation(2788))

		const split = loadImportanceSplit(db)

		expect(split.source).toBe(IMPORTANCE_SPLIT_SOURCES.legacyReconstructed)
		expect(split.legacyFallbackRows).toBe(1)
		expect(split.encyclopedic.get(1)).toBe(0.5683)
		expect(split.encyclopedic.get(2)).toBe(0.1173)
		expect(split.encyclopedic.has(3)).toBe(false)
		expect(split.referential.get(1)).toBe(referentialFromPopulation(418))
		expect(split.referential.get(2)).toBe(referentialFromPopulation(96_128))
	})

	it("falls back to population alone when there is no importance table", () => {
		using db = new DatabaseClient<PlaceImportanceDatabase>(":memory:")
		seedPopulation(db, [[1, 96_128]])

		const split = loadImportanceSplit(db)

		expect(split.source).toBe(IMPORTANCE_SPLIT_SOURCES.populationOnly)
		expect(split.referential.get(1)).toBe(referentialFromPopulation(96_128))
		expect(split.encyclopedic.size).toBe(0)
	})

	it("reports `none` rather than a table of zeros when the database carries no salience at all", () => {
		using db = new DatabaseClient<PlaceImportanceDatabase>(":memory:")

		const split = loadImportanceSplit(db)

		expect(split.source).toBe(IMPORTANCE_SPLIT_SOURCES.none)
		expect(split.referential.size).toBe(0)
	})
})

//#endregion
