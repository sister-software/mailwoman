/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	isFloorDesignatorToken,
	lookupFloorDesignator,
	US_FLOOR_DESIGNATOR_LOOKUP,
	US_FLOOR_DESIGNATOR_PREFERRED_ABBR,
	US_FLOOR_DESIGNATOR_TOKENS,
	US_FLOOR_DESIGNATORS,
} from "./floor-designator.js"

describe("US_FLOOR_DESIGNATORS", () => {
	it("carries the four USPS Pub 28 C2 floor-class designators", () => {
		const names = US_FLOOR_DESIGNATORS.map((r) => r.name).sort()
		expect(names).toEqual(["BASEMENT", "FLOOR", "LOBBY", "PENTHOUSE"].sort())
	})

	it("marks FLOOR and BASEMENT as requiring a secondary number (Appendix C2)", () => {
		const numbered = US_FLOOR_DESIGNATORS.filter((r) => r.requiresNumber)
			.map((r) => r.name)
			.sort()
		expect(numbered).toEqual(["BASEMENT", "FLOOR"].sort())
	})

	it("marks PENTHOUSE and LOBBY as standalone (Appendix C2)", () => {
		const standalone = US_FLOOR_DESIGNATORS.filter((r) => !r.requiresNumber)
			.map((r) => r.name)
			.sort()
		expect(standalone).toEqual(["LOBBY", "PENTHOUSE"].sort())
	})

	it("every row has a non-empty name and abbreviation — structural integrity", () => {
		for (const row of US_FLOOR_DESIGNATORS) {
			expect(row.name.length).toBeGreaterThan(0)
			expect(row.abbreviation.length).toBeGreaterThan(0)
		}
	})
})

describe("US_FLOOR_DESIGNATOR_LOOKUP", () => {
	it("maps canonical names, abbreviations, and variants to the canonical key", () => {
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("floor")).toBe("FLOOR")
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("fl")).toBe("FLOOR")
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("flr")).toBe("FLOOR")
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("basement")).toBe("BASEMENT")
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("bsmt")).toBe("BASEMENT")
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("penthouse")).toBe("PENTHOUSE")
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("ph")).toBe("PENTHOUSE")
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("lobby")).toBe("LOBBY")
		expect(US_FLOOR_DESIGNATOR_LOOKUP.get("lbby")).toBe("LOBBY")
	})

	it("does not know non-floor unit designators", () => {
		expect(US_FLOOR_DESIGNATOR_LOOKUP.has("apt")).toBe(false)
		expect(US_FLOOR_DESIGNATOR_LOOKUP.has("ste")).toBe(false)
		expect(US_FLOOR_DESIGNATOR_LOOKUP.has("rm")).toBe(false)
	})
})

describe("US_FLOOR_DESIGNATOR_TOKENS", () => {
	it("includes all lookup keys as lowercase tokens", () => {
		for (const key of US_FLOOR_DESIGNATOR_LOOKUP.keys()) {
			expect(US_FLOOR_DESIGNATOR_TOKENS.has(key), `token "${key}"`).toBe(true)
		}
	})
})

describe("US_FLOOR_DESIGNATOR_PREFERRED_ABBR", () => {
	it("gives the approved USPS abbreviation per canonical name", () => {
		expect(US_FLOOR_DESIGNATOR_PREFERRED_ABBR.FLOOR).toBe("FL")
		expect(US_FLOOR_DESIGNATOR_PREFERRED_ABBR.BASEMENT).toBe("BSMT")
		expect(US_FLOOR_DESIGNATOR_PREFERRED_ABBR.PENTHOUSE).toBe("PH")
		expect(US_FLOOR_DESIGNATOR_PREFERRED_ABBR.LOBBY).toBe("LBBY")
	})
})

describe("lookupFloorDesignator", () => {
	it("looks up by canonical name, abbreviation, or variant", () => {
		expect(lookupFloorDesignator("Floor")).toEqual({ designator: "FLOOR", abbreviation: "FL" })
		expect(lookupFloorDesignator("FL")).toEqual({ designator: "FLOOR", abbreviation: "FL" })
		expect(lookupFloorDesignator("flr")).toEqual({ designator: "FLOOR", abbreviation: "FL" })
		expect(lookupFloorDesignator("Basement")).toEqual({ designator: "BASEMENT", abbreviation: "BSMT" })
		expect(lookupFloorDesignator("PH")).toEqual({ designator: "PENTHOUSE", abbreviation: "PH" })
		expect(lookupFloorDesignator("LBBY")).toEqual({ designator: "LOBBY", abbreviation: "LBBY" })
	})

	it("returns null for non-floor tokens and empty input", () => {
		expect(lookupFloorDesignator("apt")).toBeNull()
		expect(lookupFloorDesignator("nope")).toBeNull()
		expect(lookupFloorDesignator(null)).toBeNull()
		expect(lookupFloorDesignator(undefined)).toBeNull()
		expect(lookupFloorDesignator("")).toBeNull()
	})
})

describe("isFloorDesignatorToken", () => {
	it("is case-insensitive", () => {
		expect(isFloorDesignatorToken("Floor")).toBe(true)
		expect(isFloorDesignatorToken("FL")).toBe(true)
		expect(isFloorDesignatorToken("flr")).toBe(true)
		expect(isFloorDesignatorToken("BSMT")).toBe(true)
		expect(isFloorDesignatorToken("ph")).toBe(true)
		expect(isFloorDesignatorToken("LBBY")).toBe(true)
	})

	it("rejects non-floor tokens", () => {
		expect(isFloorDesignatorToken("apt")).toBe(false)
		expect(isFloorDesignatorToken("4B")).toBe(false)
		expect(isFloorDesignatorToken("#3")).toBe(false)
	})
})
