/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isUsStateAbbreviation } from "./state.ts"
import {
	isZipCode,
	pluckStateZIPCode,
	StateAbbreviationZipCodePrefixRecord,
	ZipCodePatterns,
	ZipCodePrefixAbbreviationMap,
} from "./zipcode.ts"

describe("isZipCode", () => {
	it("accepts 5-digit and ZIP+4 forms", () => {
		expect(isZipCode("90210")).toBe(true)
		expect(isZipCode("90210-1234")).toBe(true)
		expect(isZipCode("90210 1234")).toBe(true)
	})

	it("rejects non-ZIP strings", () => {
		expect(isZipCode("9021")).toBe(false)
		expect(isZipCode("ABCDE")).toBe(false)
		expect(isZipCode(90210)).toBe(false)
	})
})

describe("StateAbbreviationZipCodePrefixRecord", () => {
	it("encodes the first-digit → state geographic prior", () => {
		expect(StateAbbreviationZipCodePrefixRecord.CA).toBe(9)
		expect(StateAbbreviationZipCodePrefixRecord.NY).toBe(1)
		expect(StateAbbreviationZipCodePrefixRecord.FL).toBe(3)
	})

	it("inverts into the prefix → states map (band 0 holds the New England + DE/PR cluster)", () => {
		const band0 = ZipCodePrefixAbbreviationMap.get(0)
		expect(band0).toContain("MA")
		expect(band0).toContain("CT")
		expect(band0).toContain("NH")
	})
})

describe("pluckStateZIPCode", () => {
	it("plucks a state + ZIP from `CA 94016`", () => {
		expect(pluckStateZIPCode("CA 94016")).toEqual({ stateAbbreviation: "CA", zipCode: "94016" })
	})

	it("normalizes a lowercase state abbreviation", () => {
		expect(pluckStateZIPCode("ca 94016")).toEqual({ stateAbbreviation: "CA", zipCode: "94016" })
	})

	it("returns a null state when the leading token is not a real abbreviation", () => {
		// "ZZ" is a valid two-letter shape but not a state, so the ZIP is kept and the state is null.
		expect(pluckStateZIPCode("ZZ 94016")).toEqual({ stateAbbreviation: null, zipCode: "94016" })
	})

	it("handles a bare ZIP", () => {
		expect(pluckStateZIPCode("94016")).toEqual({ stateAbbreviation: null, zipCode: "94016" })
	})

	it("returns null when there is no ZIP", () => {
		expect(pluckStateZIPCode("CA")).toBeNull()
		expect(pluckStateZIPCode(null)).toBeNull()
	})
})

describe("isUsStateAbbreviation", () => {
	it("accepts states + territories, case-insensitively", () => {
		expect(isUsStateAbbreviation("CA")).toBe(true)
		expect(isUsStateAbbreviation("pr")).toBe(true)
		expect(isUsStateAbbreviation("ZZ")).toBe(false)
	})
})

describe("ZipCodePatterns", () => {
	it("Standard matches a bare ZIP, StateAbbreviationWithZipCode captures the parts", () => {
		expect(ZipCodePatterns.Standard.test("12345")).toBe(true)
		const [, state, zip] = "TX 75001".match(ZipCodePatterns.StateAbbreviationWithZipCode)!
		expect(state).toBe("TX")
		expect(zip).toBe("75001")
	})
})
