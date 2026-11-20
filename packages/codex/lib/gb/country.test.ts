// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isUkCountryCode, lookupUkCountry, ukCountryForGSS } from "#gb"

describe("ukCountryForGSS", () => {
	it("maps each ONS country code to its constituent country", () => {
		expect(ukCountryForGSS("W92000004")).toBe("WLS")
		expect(ukCountryForGSS("s92000003")).toBe("SCT")
		expect(ukCountryForGSS("E92000001")).toBe("ENG")
	})

	it("returns null for a code that identifies no constituent country", () => {
		expect(ukCountryForGSS("K02000001")).toBeNull() // the United Kingdom itself
		expect(ukCountryForGSS("")).toBeNull()
	})
})

describe("isUkCountryCode", () => {
	it("accepts ISO 3166-2:GB codes, case-insensitively", () => {
		expect(isUkCountryCode("ENG")).toBe(true)
		expect(isUkCountryCode("sct")).toBe(true)
		expect(isUkCountryCode("BY")).toBe(false) // a German state rather than a UK country
	})
})

describe("lookupUkCountry", () => {
	it("resolves ISO code and English name to the ISO code", () => {
		expect(lookupUkCountry("ENG")).toBe("ENG")
		expect(lookupUkCountry("England")).toBe("ENG")
		expect(lookupUkCountry("Scotland")).toBe("SCT")
		expect(lookupUkCountry("wales")).toBe("WLS")
		expect(lookupUkCountry("Northern Ireland")).toBe("NIR")
		expect(lookupUkCountry("northern-ireland")).toBe("NIR")
	})

	it("returns null for an unknown country", () => {
		expect(lookupUkCountry("Ireland")).toBeNull() // the Republic rather than a UK country
		expect(lookupUkCountry("Bavaria")).toBeNull()
		expect(lookupUkCountry(null)).toBeNull()
	})
})
