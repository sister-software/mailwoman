// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isGermanStateCode, lookupGermanState } from "#de"

describe("isGermanStateCode", () => {
	it("accepts ISO 3166-2:DE codes, case-insensitively", () => {
		expect(isGermanStateCode("BY")).toBe(true)
		expect(isGermanStateCode("nw")).toBe(true)
		expect(isGermanStateCode("CA")).toBe(false) // a US state rather than German
	})
})

describe("lookupGermanState", () => {
	it("resolves code, German name, English exonym, and common alias to the ISO code", () => {
		expect(lookupGermanState("BY")).toBe("BY")
		expect(lookupGermanState("Bayern")).toBe("BY")
		expect(lookupGermanState("Bavaria")).toBe("BY")
		expect(lookupGermanState("Saxony")).toBe("SN")
		expect(lookupGermanState("NRW")).toBe("NW")
		expect(lookupGermanState("Nordrhein-Westfalen")).toBe("NW")
	})

	it("returns null for an unknown region", () => {
		expect(lookupGermanState("California")).toBeNull()
		expect(lookupGermanState(null)).toBeNull()
	})
})
