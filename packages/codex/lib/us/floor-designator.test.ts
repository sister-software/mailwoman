// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import {
	isFloorDesignatorToken,
	lookupFloorDesignator,
	US_FLOOR_DESIGNATOR_LOOKUP,
	US_FLOOR_DESIGNATORS,
} from "#us/floor-designator"

describe("US_FLOOR_DESIGNATORS", () => {
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
		expect(lookupFloorDesignator(null)).toBeNull()
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
