/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the shared repair-pass skeleton (`span-repair.ts`). `postcode-repair.test.ts` and
 *   `unit-repair.test.ts` cover these helpers end-to-end through their own passes; this file pins
 *   the selection rules directly so a future edit to the tie-break cannot slip through as a
 *   pass-specific change. The ZIP+4-vs-NL case is the one the longest-first rule exists for.
 */

import type { BIOLabel, DecoderToken } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { selectNonOverlappingMatches, tagOf, tokenIndicesOverlapping } from "./span-repair.ts"

const tok = (piece: string, start: number, label: BIOLabel): DecoderToken => ({
	confidence: 1,
	end: start + piece.length,
	label,
	piece,
	start,
})

describe("selectNonOverlappingMatches", () => {
	it("keeps the longest match and drops what overlaps it", () => {
		// "94610-2737 CA": the ZIP+4 (10 chars) and the NL-shaped tail "2737 CA" (7 chars) overlap.
		const accepted = selectNonOverlappingMatches([
			{ end: 13, priority: 4, start: 6 }, // NL shape, more specific pattern
			{ end: 10, priority: 5, start: 0 }, // ZIP+4, longer
		])

		expect(accepted).toEqual([{ end: 10, priority: 5, start: 0 }])
	})

	it("breaks a length tie on priority, lower first", () => {
		const accepted = selectNonOverlappingMatches([
			{ end: 5, priority: 3, start: 0 },
			{ end: 5, priority: 1, start: 0 },
		])

		expect(accepted).toEqual([{ end: 5, priority: 1, start: 0 }])
	})

	it("keeps every disjoint match, and touching ranges do not count as overlapping", () => {
		const accepted = selectNonOverlappingMatches([
			{ end: 5, priority: 0, start: 0 },
			{ end: 10, priority: 0, start: 5 },
		])

		expect(accepted).toHaveLength(2)
	})

	it("does not mutate the caller's array", () => {
		const candidates = [
			{ end: 3, priority: 0, start: 0 },
			{ end: 20, priority: 1, start: 10 },
		]

		const snapshot = [...candidates]

		selectNonOverlappingMatches(candidates)

		expect(candidates).toEqual(snapshot)
	})

	it("returns nothing for no candidates", () => {
		expect(selectNonOverlappingMatches([])).toEqual([])
	})
})

describe("tokenIndicesOverlapping", () => {
	const tokens = [tok("123", 0, "O"), tok("Main", 4, "O"), tok("St", 9, "O")]

	it("returns the indices whose char span intersects the range", () => {
		expect(tokenIndicesOverlapping(tokens, 4, 11)).toEqual([1, 2])
	})

	it("treats the range as half-open — a shared boundary is not an overlap", () => {
		expect(tokenIndicesOverlapping(tokens, 3, 4)).toEqual([])
	})

	it("returns nothing when the range falls between tokens", () => {
		expect(tokenIndicesOverlapping(tokens, 8, 9)).toEqual([])
	})
})

describe("tagOf", () => {
	it("strips the BIO prefix", () => {
		expect(tagOf("B-locality")).toBe("locality")
		expect(tagOf("I-postcode")).toBe("postcode")
	})

	it("maps O to null", () => {
		expect(tagOf("O")).toBeNull()
	})
})
