/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { jaro, jaroWinkler, levenshteinSimilarity, nameSimilarity } from "./comparators.js"

describe("jaro", () => {
	it("is 1 for identical strings and 0 for an empty operand", () => {
		expect(jaro("smith", "smith")).toBe(1)
		expect(jaro("", "smith")).toBe(0)
		expect(jaro("", "")).toBe(1)
	})

	it("is 0 when no characters match", () => {
		expect(jaro("abc", "xyz")).toBe(0)
	})

	it("matches the canonical reference values", () => {
		expect(jaro("martha", "marhta")).toBeCloseTo(0.9444, 3)
		expect(jaro("dwayne", "duane")).toBeCloseTo(0.8222, 3)
		expect(jaro("dixon", "dicksonx")).toBeCloseTo(0.7667, 3)
	})
})

describe("jaroWinkler", () => {
	it("boosts a shared prefix above the base Jaro score", () => {
		expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 3)
		expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2)
		expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 3)
	})

	it("reproduces the compound-surname asymmetry from the literature", () => {
		// Garcia is a prefix of Garcialopez → high; Lopez falls outside the match window → 0.
		expect(jaroWinkler("garcia", "garcialopez")).toBeCloseTo(0.9091, 3)
		expect(jaroWinkler("lopez", "garcialopez")).toBe(0)
	})

	it("does not boost when base Jaro is below threshold", () => {
		expect(jaroWinkler("abc", "xyz")).toBe(0)
	})
})

describe("levenshteinSimilarity", () => {
	it("normalizes edit distance into a [0,1] similarity", () => {
		expect(levenshteinSimilarity("kitten", "kitten")).toBe(1)
		expect(levenshteinSimilarity("kitten", "sitting")).toBeCloseTo(1 - 3 / 7, 5)
		expect(levenshteinSimilarity("", "")).toBe(1)
	})
})

describe("nameSimilarity", () => {
	it("is 1 for identical names and 0 for empty input", () => {
		expect(nameSimilarity("Smith", "smith ")).toBe(1)
		expect(nameSimilarity("", "Smith")).toBe(0)
	})

	it("floors a token-subset (single surname within a compound) at 0.9", () => {
		expect(nameSimilarity("Lopez", "Garcia Lopez")).toBeGreaterThanOrEqual(0.9)
	})

	it("recovers the compound case J-W misses via the edit-distance fallback", () => {
		// jaroWinkler("lopez","garcialopez") is 0; the fallback lifts it well above 0.
		expect(nameSimilarity("Lopez", "Garcialopez")).toBeGreaterThan(0.4)
	})

	it("still rewards a typo'd single name via Jaro-Winkler", () => {
		expect(nameSimilarity("Martha", "Marhta")).toBeGreaterThan(0.9)
	})
})
