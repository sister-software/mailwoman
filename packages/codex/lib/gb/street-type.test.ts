// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { isBritishStreetWord } from "#gb"

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
