// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isRegionAbbreviationToken } from "#region-abbreviation"

describe("isRegionAbbreviationToken", () => {
	it("accepts two uppercase ASCII letters by default", () => {
		expect(isRegionAbbreviationToken("NY")).toBe(true)
		expect(isRegionAbbreviationToken("DC")).toBe(true)
	})

	it("refuses one letter, three letters at the default limit, lowercase and non-letters", () => {
		expect(isRegionAbbreviationToken("N")).toBe(false)
		expect(isRegionAbbreviationToken("TWN")).toBe(false)
		expect(isRegionAbbreviationToken("ny")).toBe(false)
		expect(isRegionAbbreviationToken("N1")).toBe(false)
		expect(isRegionAbbreviationToken("")).toBe(false)
	})

	it("accepts a longer run up to the limit it is given", () => {
		expect(isRegionAbbreviationToken("TWN", { maxLetters: 3 })).toBe(true)
		expect(isRegionAbbreviationToken("TWNS", { maxLetters: 3 })).toBe(false)
	})
})
