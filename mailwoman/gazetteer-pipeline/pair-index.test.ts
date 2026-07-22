/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the placetype-pair-prior arc's row→pair fold/dedupe/skip logic (Task 3):
 *   {@link PairIndexBuilder} + {@link nearestRankPercentile}. Fixture rows mirror the real PPD tuple
 *   shape (`corpus/src/shard-recipes/locale.ts`'s `districtAsLocality` gate) without touching the CSV
 *   read path — CSVSpliterator itself is exercised elsewhere (`locale.test.ts`).
 */

import { describe, expect, it } from "vitest"

import { PairIndexBuilder, nearestRankPercentile } from "./pair-index.ts"

describe("PairIndexBuilder", () => {
	it("folds CITY/DISTRICT through normalizeFSTToken and tags dependent_locality", () => {
		const b = new PairIndexBuilder()

		b.addRow("Fishburn", "Stockton-on-Tees")
		const { entries } = b.finish()

		expect(entries).toEqual([{ child: "fishburn", parent: "stocktonontees", tag: "dependent_locality" }])
	})

	it("dedupes repeated (child, parent) pairs across rows", () => {
		const b = new PairIndexBuilder()

		b.addRow("Shoreditch", "London")
		b.addRow("Shoreditch", "London")
		b.addRow("Shoreditch", "London")
		const { entries, rowsKept } = b.finish()

		expect(entries).toHaveLength(1)
		expect(rowsKept).toBe(3)
	})

	it("keeps distinct pairs sharing a child with different parents", () => {
		const b = new PairIndexBuilder()

		b.addRow("Newport", "Barnstaple")
		b.addRow("Newport", "Isle of Wight")
		const { entries } = b.finish()

		expect(entries).toHaveLength(2)
		expect(entries.map((e) => e.parent).sort()).toEqual(["barnstaple", "isle of wight"])
	})

	it("skips rows with an empty CITY and counts them separately from kept rows", () => {
		const b = new PairIndexBuilder()

		b.addRow("", "London")
		b.addRow("   ", "Enfield")
		b.addRow("Camden", "London")
		const { entries, rowsKept, rowsSkipped } = b.finish()

		expect(rowsSkipped).toBe(2)
		expect(rowsKept).toBe(1)
		expect(entries).toEqual([{ child: "camden", parent: "london", tag: "dependent_locality" }])
	})

	it("folds an empty DISTRICT to an empty parent string rather than dropping the row", () => {
		const b = new PairIndexBuilder()

		b.addRow("Somewhere", "")
		const { entries } = b.finish()

		expect(entries).toEqual([{ child: "somewhere", parent: "", tag: "dependent_locality" }])
	})

	it("computes the raw (pre-fold) CITY word-length distribution over kept rows only", () => {
		const b = new PairIndexBuilder()

		b.addRow("Shoreditch", "London") // 1 word
		b.addRow("Stockton on the Forest", "York") // 4 words
		b.addRow("Great Warley", "Brentwood") // 2 words
		b.addRow("", "Skipped") // not counted (empty CITY)
		const { distribution } = b.finish()

		expect(distribution.totalRows).toBe(3)
		expect(distribution.max).toBe(4)
		expect(distribution.counts).toEqual([
			{ words: 1, rows: 1 },
			{ words: 2, rows: 1 },
			{ words: 4, rows: 1 },
		])
	})

	it("returns a zeroed distribution when every row is skipped", () => {
		const b = new PairIndexBuilder()

		b.addRow("", "London")
		const { distribution } = b.finish()

		expect(distribution).toEqual({ totalRows: 0, p50: 0, p90: 0, p99: 0, max: 0, counts: [] })
	})
})

describe("nearestRankPercentile", () => {
	it("computes p50/p90/p99 via nearest-rank over a sorted array", () => {
		const sorted = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100

		expect(nearestRankPercentile(sorted, 50)).toBe(50)
		expect(nearestRankPercentile(sorted, 90)).toBe(90)
		expect(nearestRankPercentile(sorted, 99)).toBe(99)
	})

	it("clamps to the last element when the requested percentile rounds past the array length", () => {
		expect(nearestRankPercentile([1, 2, 3], 99)).toBe(3)
	})

	it("throws on an empty array rather than silently returning 0", () => {
		expect(() => nearestRankPercentile([], 50)).toThrow(/empty/)
	})
})
