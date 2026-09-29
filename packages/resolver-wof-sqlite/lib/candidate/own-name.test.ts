/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the own-name variant predicate and its similarity floor.
 */

import { describe, expect, it } from "vitest"

import {
	expandNameAbbreviations,
	isOwnNameVariant,
	ownNameSimilarity,
	romanizeNameKey,
	VARIANT_SIMILARITY_MIN,
} from "#candidate/own-name"

describe("isOwnNameVariant — the measured census contests", () => {
	it("admits the holder's own name in another orthography", () => {
		expect(isOwnNameVariant("брэст", "brest")).toBe(true)
		expect(isOwnNameVariant("george town", "georgetown")).toBe(true)
		expect(isOwnNameVariant("saint george s", "st georges")).toBe(true)
		expect(isOwnNameVariant("адамовка", "adamowka")).toBe(true)
	})

	it("refuses the coincidental-collision class the penalty exists for", () => {
		expect(isOwnNameVariant("чанчунь", "cancun")).toBe(false)
		expect(isOwnNameVariant("augsburg", "augusta")).toBe(false)
		expect(isOwnNameVariant("west bay", "west end")).toBe(false)
	})

	it("refuses the near-identical DIFFERENT places (Liévin vs Levin) and the dual-name class (Derry/Londonderry)", () => {
		expect(isOwnNameVariant("lievin", "levin")).toBe(false)
		expect(isOwnNameVariant("derry", "londonderry")).toBe(false)
	})

	it("answers no-verdict — never a stamp — on an uncovered script", () => {
		// Arabic-script primary (Abadan, Iran): the romanizer covers Cyrillic only.
		// and absence of a verdict must not read as "different name".
		expect(ownNameSimilarity("آبادان", "abadan")).toBeNull()
		expect(isOwnNameVariant("آبادان", "abadan")).toBe(false)
	})
})

describe("romanizeNameKey", () => {
	it("romanizes Cyrillic and passes Latin through folded", () => {
		expect(romanizeNameKey("брэст")).toBe("brest")
		expect(romanizeNameKey("адамовка")).toBe("adamovka")
		expect(romanizeNameKey("george town")).toBe("george town")
	})

	it("returns null when foreign characters survive", () => {
		expect(romanizeNameKey("阿克苏")).toBeNull()
		expect(romanizeNameKey("עכו")).toBeNull()
	})
})

describe("expandNameAbbreviations", () => {
	it("expands whole words only", () => {
		expect(expandNameAbbreviations("st georges")).toBe("saint georges")
		expect(expandNameAbbreviations("mt eden")).toBe("mount eden")
		expect(expandNameAbbreviations("stanley")).toBe("stanley")
	})
})

describe("VARIANT_SIMILARITY_MIN", () => {
	it("sits in the measured band: nearest admitted 0.875, nearest refused 0.833", () => {
		expect(VARIANT_SIMILARITY_MIN).toBe(0.85)
		expect(ownNameSimilarity("адамовка", "adamowka")).toBeCloseTo(0.875, 3)
		expect(ownNameSimilarity("lievin", "levin")).toBeCloseTo(0.833, 3)
	})
})
