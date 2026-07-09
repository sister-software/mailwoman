/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	isUnitDesignatorToken,
	lookupUnitDesignator,
	matchLeadingDesignator,
	US_UNIT_DESIGNATOR_LOOKUP,
	US_UNIT_DESIGNATOR_PREFERRED_ABBR,
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
