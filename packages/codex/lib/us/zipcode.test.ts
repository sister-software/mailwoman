// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import {
	isZipCode,
	pluckStateZIPCode,
	StateAbbreviationZipCodePrefixRecord,
	ZipCodePatterns,
	ZipCodePrefixAbbreviationMap,
} from "#us"
import { isUSStateAbbreviation } from "#us/state"
import { normalizeZIPCode } from "#us/zipcode"

describe("normalizeZIPCode", () => {
	it("restores the leading zeros a numeric column dropped, when the state's codes begin with zero", () => {
		expect(normalizeZIPCode("612", "PR")).toBe("00612")
		expect(normalizeZIPCode("6103", "CT")).toBe("06103")
	})

	it("refuses a padded code another state's first digit would need", () => {
		expect(normalizeZIPCode("7341", "TX")).toBeNull()
	})

	it("refuses a short value that kept its leading zero, which lost its trailing digits", () => {
		expect(normalizeZIPCode("0494", "ME")).toBeNull()
	})

	it("reads the other spellings sources write back to the code", () => {
		expect(normalizeZIPCode("19311.0", "PA")).toBe("19311")
		expect(normalizeZIPCode("368010028", "AL")).toBe("36801-0028")
		expect(normalizeZIPCode("35175-", "AL")).toBe("35175")
		expect(normalizeZIPCode("76442-*", "TX")).toBe("76442")
		expect(normalizeZIPCode("6121234", "PR")).toBe("00612-1234")
		expect(normalizeZIPCode("9300428", "CA")).toBeNull()
	})

	it("refuses a city name, a state code or a six-digit value written in the ZIP Code column", () => {
		for (const value of ["CLEAR LAKE", "AL", "350062"]) {
			expect(normalizeZIPCode(value, "AL")).toBeNull()
		}
	})

	it("keeps a five-digit ZIP Code and a ZIP+4, and refuses placeholders", () => {
		expect(normalizeZIPCode("95678", "CA")).toBe("95678")
		expect(normalizeZIPCode("95678-1234", "CA")).toBe("95678-1234")

		for (const placeholder of ["0", "-", "N/A", "PA", "0.0", null]) {
			expect(normalizeZIPCode(placeholder, "PA")).toBeNull()
		}
	})
})

describe("isZipCode", () => {
	it("accepts 5-digit and ZIP+4 forms", () => {
		expect(isZipCode("90210")).toBe(true)
		expect(isZipCode("90210-1234")).toBe(true)
		expect(isZipCode("90210 1234")).toBe(true)
	})

	it("rejects non-ZIP strings", () => {
		expect(isZipCode("9021")).toBe(false)
		expect(isZipCode("ABCDE")).toBe(false)
		expect(isZipCode(90_210)).toBe(false)
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

describe("isUSStateAbbreviation", () => {
	it("accepts states + territories, case-insensitively", () => {
		expect(isUSStateAbbreviation("CA")).toBe(true)
		expect(isUSStateAbbreviation("pr")).toBe(true)
		expect(isUSStateAbbreviation("ZZ")).toBe(false)
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
