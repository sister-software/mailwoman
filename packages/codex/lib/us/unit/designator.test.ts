/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	isSecondaryUnitDesignatorToken,
	isUnitDesignatorToken,
	lookupUnitDesignator,
	matchLeadingDesignator,
	matchLeadingDesignatorWithRange,
	US_UNIT_DESIGNATOR_LOOKUP,
	US_UNIT_DESIGNATOR_PREFERRED_ABBR,
	US_UNIT_DESIGNATOR_REQUIRES_RANGE,
	US_UNIT_DESIGNATOR_VARIANTS,
	usUnitIdentifier,
} from "#us/unit/designator"

describe("usUnitIdentifier", () => {
	it("reads one identifier from a designator, a pound sign or a bare value", () => {
		for (const unit of ["UNIT 2", "Apt. 2", "apartment 2", "#2", "Apt #2", "2", " 2 "]) {
			expect(usUnitIdentifier(unit), unit).toBe("2")
		}

		expect(usUnitIdentifier("UNIT B")).toBe("b")
		expect(usUnitIdentifier("Suite 4-B")).toBe("4b")
	})

	it("reads a designator that stands alone as its canonical designator, and folds a unit without one whole", () => {
		expect(usUnitIdentifier("Basement")).toBe(usUnitIdentifier("BSMT"))
		expect(usUnitIdentifier("North Wing")).toBe("northwing")
	})

	it("returns null for an absent or empty unit", () => {
		expect(usUnitIdentifier(null)).toBeNull()
		expect(usUnitIdentifier(undefined)).toBeNull()
		expect(usUnitIdentifier("  ")).toBeNull()
	})

	it("drops designator words wherever they stand", () => {
		expect(usUnitIdentifier("BLDG 25 FL 1")).toBe(usUnitIdentifier("25 1"))
		expect(usUnitIdentifier("FL 2 #201")).toBe(usUnitIdentifier("2 #201"))
		expect(usUnitIdentifier("MBL HM CRT SPACE")).toBe(usUnitIdentifier("MBL HM CRT"))
		expect(usUnitIdentifier("2 #202")).not.toBe(usUnitIdentifier("FL 2 #200"))
	})

	it("drops leading zeros from a numeric identifier and keeps differing numbers apart", () => {
		expect(usUnitIdentifier("UNIT 0807")).toBe(usUnitIdentifier("807"))
		expect(usUnitIdentifier("808")).not.toBe(usUnitIdentifier("0807"))
	})

	it("reads a placeholder, the record's house number, or its number and street as no unit", () => {
		expect(usUnitIdentifier("<Null>")).toBeNull()
		expect(usUnitIdentifier("108", { number: "108", street: "17th St" })).toBeNull()
		expect(usUnitIdentifier("108 17th St", { number: "108", street: "17th St" })).toBeNull()
		expect(usUnitIdentifier("2", { number: "108", street: "17th St" })).toBe("2")
		expect(usUnitIdentifier("#2", { number: "2", street: "Main Street" })).toBe("2")
	})
})

describe("US_UNIT_DESIGNATOR_LOOKUP", () => {
	it("maps canonical, full-word, and abbreviated variants to the canonical key", () => {
		expect(US_UNIT_DESIGNATOR_LOOKUP.get("apartment")).toBe("APARTMENT")
		expect(US_UNIT_DESIGNATOR_LOOKUP.get("apt")).toBe("APARTMENT")
		expect(US_UNIT_DESIGNATOR_LOOKUP.get("ste")).toBe("SUITE")
		expect(US_UNIT_DESIGNATOR_LOOKUP.get("suite")).toBe("SUITE")
		expect(US_UNIT_DESIGNATOR_LOOKUP.get("fl")).toBe("FLOOR")
		expect(US_UNIT_DESIGNATOR_LOOKUP.get("rm")).toBe("ROOM")
	})

	it("does not know unrelated words", () => {
		expect(US_UNIT_DESIGNATOR_LOOKUP.has("4b")).toBe(false)
		expect(US_UNIT_DESIGNATOR_LOOKUP.has("oakland")).toBe(false)
	})
})

describe("US_UNIT_DESIGNATOR_PREFERRED_ABBR", () => {
	it("gives the approved USPS abbreviation per canonical", () => {
		expect(US_UNIT_DESIGNATOR_PREFERRED_ABBR.APARTMENT).toBe("APT")
		expect(US_UNIT_DESIGNATOR_PREFERRED_ABBR.SUITE).toBe("STE")
		expect(US_UNIT_DESIGNATOR_PREFERRED_ABBR.FLOOR).toBe("FL")
	})
})

describe("matchLeadingDesignator", () => {
	it("matches the LEADING designator word and reports the matched surface form", () => {
		expect(matchLeadingDesignator("Apt 4B")).toEqual({ canonical: "APARTMENT", matched: "Apt" })
		expect(matchLeadingDesignator("SUITE 200")).toEqual({ canonical: "SUITE", matched: "SUITE" })
		expect(matchLeadingDesignator("Basement")).toEqual({ canonical: "BASEMENT", matched: "Basement" })
	})

	it("returns null on a bare identifier or empty input", () => {
		expect(matchLeadingDesignator("4B")).toBeNull()
		expect(matchLeadingDesignator("#210")).toBeNull()
		expect(matchLeadingDesignator("")).toBeNull()
	})

	it("only matches the LEADING word (a trailing designator-shaped token is ignored)", () => {
		// "Building" is a designator, but here it's not the leading token.
		expect(matchLeadingDesignator("4B Building")).toBeNull()
	})
})

describe("lookupUnitDesignator + isUnitDesignatorToken", () => {
	it("looks up by canonical, abbreviation, or variant", () => {
		expect(lookupUnitDesignator("Suite")).toEqual({ designator: "SUITE", abbreviation: "STE" })
		expect(lookupUnitDesignator("apt")).toEqual({ designator: "APARTMENT", abbreviation: "APT" })
		expect(lookupUnitDesignator("nope")).toBeNull()
		expect(lookupUnitDesignator(null)).toBeNull()
	})

	it("isUnitDesignatorToken is case-insensitive", () => {
		expect(isUnitDesignatorToken("Apt")).toBe(true)
		expect(isUnitDesignatorToken("STE")).toBe(true)
		expect(isUnitDesignatorToken("floor")).toBe(true)
		expect(isUnitDesignatorToken("4B")).toBe(false)
	})
})

describe("US_UNIT_DESIGNATOR_VARIANTS table integrity", () => {
	const canonicals = Object.keys(US_UNIT_DESIGNATOR_VARIANTS) as (keyof typeof US_UNIT_DESIGNATOR_VARIANTS)[]

	it("has exactly the 24 USPS Pub-28 Appendix C2 designators", () => {
		expect(canonicals).toHaveLength(24)
	})

	it("has no variant string claimed by two different canonicals", () => {
		const owner = new Map<string, string>()

		for (const canonical of canonicals) {
			for (const variant of US_UNIT_DESIGNATOR_VARIANTS[canonical]) {
				const existing = owner.get(variant)

				expect(existing, `variant ${variant} claimed by both ${existing} and ${canonical}`).toBeUndefined()
				owner.set(variant, canonical)
			}
		}
	})

	it("every canonical resolves to itself in the lookup (case-insensitive)", () => {
		for (const canonical of canonicals) {
			expect(US_UNIT_DESIGNATOR_LOOKUP.get(canonical.toLowerCase())).toBe(canonical)
		}
	})

	it("every canonical has US_UNIT_DESIGNATOR_REQUIRES_RANGE + US_UNIT_DESIGNATOR_PREFERRED_ABBR entries", () => {
		for (const canonical of canonicals) {
			expect(typeof US_UNIT_DESIGNATOR_REQUIRES_RANGE[canonical]).toBe("boolean")
			expect(typeof US_UNIT_DESIGNATOR_PREFERRED_ABBR[canonical]).toBe("string")
		}
	})
})

describe("US_UNIT_DESIGNATOR_REQUIRES_RANGE", () => {
	it("flags the designators Pub-28 marks as requiring a secondary number", () => {
		for (const canonical of ["APARTMENT", "BUILDING", "DEPARTMENT", "FLOOR", "ROOM", "SUITE", "UNIT"] as const) {
			expect(US_UNIT_DESIGNATOR_REQUIRES_RANGE[canonical]).toBe(true)
		}
	})

	it("does not flag the standalone designators", () => {
		for (const canonical of [
			"BASEMENT",
			"FRONT",
			"LOBBY",
			"LOWER",
			"OFFICE",
			"PENTHOUSE",
			"REAR",
			"SIDE",
			"UPPER",
		] as const) {
			expect(US_UNIT_DESIGNATOR_REQUIRES_RANGE[canonical]).toBe(false)
		}
	})
})

describe("matchLeadingDesignatorWithRange", () => {
	it("captures the designator + trailing range when present", () => {
		expect(matchLeadingDesignatorWithRange("Apt 4B")).toEqual({
			canonical: "APARTMENT",
			matched: "Apt",
			range: "4B",
			requiresRange: true,
		})

		expect(matchLeadingDesignatorWithRange("SUITE 200")).toEqual({
			canonical: "SUITE",
			matched: "SUITE",
			range: "200",
			requiresRange: true,
		})
	})

	it("leaves range undefined for a standalone designator", () => {
		expect(matchLeadingDesignatorWithRange("Basement")).toEqual({
			canonical: "BASEMENT",
			matched: "Basement",
			range: null,
			requiresRange: false,
		})

		expect(matchLeadingDesignatorWithRange("Penthouse")).toEqual({
			canonical: "PENTHOUSE",
			matched: "Penthouse",
			range: null,
			requiresRange: false,
		})
	})

	it("returns null on a bare identifier, non-designator, or empty input", () => {
		expect(matchLeadingDesignatorWithRange("4B")).toBeNull()
		expect(matchLeadingDesignatorWithRange("Main")).toBeNull()
		expect(matchLeadingDesignatorWithRange("")).toBeNull()
	})
})

describe("isSecondaryUnitDesignatorToken", () => {
	it("mirrors isUnitDesignatorToken under Pub-28's own term", () => {
		expect(isSecondaryUnitDesignatorToken("Apt")).toBe(true)
		expect(isSecondaryUnitDesignatorToken("ste")).toBe(true)
		expect(isSecondaryUnitDesignatorToken("Floor")).toBe(true)
	})

	it("is false for non-designator tokens", () => {
		expect(isSecondaryUnitDesignatorToken("MAIN")).toBe(false)
		expect(isSecondaryUnitDesignatorToken("123")).toBe(false)
		expect(isSecondaryUnitDesignatorToken("")).toBe(false)
		expect(isSecondaryUnitDesignatorToken(null)).toBe(false)
	})
})
