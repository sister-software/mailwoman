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
} from "./unit-designator.ts"

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
			range: undefined,
			requiresRange: false,
		})
		expect(matchLeadingDesignatorWithRange("Penthouse")).toEqual({
			canonical: "PENTHOUSE",
			matched: "Penthouse",
			range: undefined,
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
