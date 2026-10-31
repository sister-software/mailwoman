/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { classifyStreetGroup, evaluateRow, streetFamilyGroups, type AffixLexicon } from "./suffix/feed.ts"

const LEXICON: AffixLexicon = {
	version: "test-v2",
	directionals: { w: "W", west: "W" },
	suffixes: { rd: "ROAD", road: "ROAD", ave: "AVENUE", avenue: "AVENUE", park: "PARK", hollow: "HOLLOW", mill: "MILL" },
	nameProne: new Set(["PARK", "HOLLOW", "MILL"]),
}

describe("classifyStreetGroup", () => {
	test("a true suffix after a name-prone word is terminal-only", () => {
		expect(classifyStreetGroup(["Menlo", "Park", "Road"], LEXICON)).toBe("terminal-only")
		expect(classifyStreetGroup(["Cider", "Mill", "Rd"], LEXICON)).toBe("terminal-only")
	})

	test("a name-prone last word is terminal-contrast", () => {
		expect(classifyStreetGroup(["Sutton", "Hollow"], LEXICON)).toBe("terminal-contrast")
	})

	test("a plain suffix street and a street without a suffix are neither", () => {
		expect(classifyStreetGroup(["Maple", "Road"], LEXICON)).toBeNull()
		expect(classifyStreetGroup(["Broadway"], LEXICON)).toBeNull()
		expect(classifyStreetGroup(["Hauptstraße", "Nord"], LEXICON)).toBeNull()
	})
})

describe("evaluateRow", () => {
	const tokens = ["12", "Menlo", "Park", "Road"]
	const labels = ["B-house_number", "B-street", "I-street", "I-street"]

	test("a group whose relabeled last word is not a suffix is wrong", () => {
		expect(evaluateRow(tokens, labels, labels, LEXICON)).toEqual([["terminal-only", false]])
	})

	test("a group split at its last word is correct", () => {
		const split = ["B-house_number", "B-street", "I-street", "B-street_suffix"]

		expect(evaluateRow(tokens, labels, split, LEXICON)).toEqual([["terminal-only", true]])
	})

	test("a row without a street yields nothing", () => {
		expect(evaluateRow(["Berlin"], ["B-locality"], ["B-locality"], LEXICON)).toEqual([])
	})
})

test("a street group takes the suffix run right after the street run", () => {
	expect(streetFamilyGroups(["B-street", "I-street", "B-street_suffix", "O", "B-street"])).toEqual([[0, 1, 2], [4]])
})
