// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { GB_STREET_TYPES, isBritishStreetWord } from "@mailwoman/codex/gb"
import { describe, expect, it } from "vitest"

describe("GB_STREET_TYPES", () => {
	it("spans the common core and the distinctively British vocabulary", () => {
		expect(GB_STREET_TYPES).toContain("street")
		expect(GB_STREET_TYPES).toContain("crescent")
		expect(GB_STREET_TYPES).toContain("mews")
		expect(GB_STREET_TYPES).toContain("wynd") // Scots
		expect(GB_STREET_TYPES).toContain("brae") // Scots
	})
})

describe("isBritishStreetWord", () => {
	it("matches thoroughfare words, case-insensitively, as whole tokens", () => {
		expect(isBritishStreetWord("Crescent")).toBe(true)
		expect(isBritishStreetWord("Mews")).toBe(true)
		expect(isBritishStreetWord("Close")).toBe(true)
		expect(isBritishStreetWord("road")).toBe(true)
		expect(isBritishStreetWord("TERRACE")).toBe(true)
	})

	it("does not flag an unrelated place name", () => {
		expect(isBritishStreetWord("Tokyo")).toBe(false)
		expect(isBritishStreetWord("Bordeaux")).toBe(false)
		expect(isBritishStreetWord("London")).toBe(false)
	})

	it("rejects non-strings", () => {
		expect(isBritishStreetWord(42)).toBe(false)
		expect(isBritishStreetWord(null)).toBe(false)
	})
})
