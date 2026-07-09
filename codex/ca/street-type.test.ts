/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { isCanadianDirectional, isCanadianStreetWord } from "./street-type.ts"

describe("isCanadianStreetWord", () => {
	it("matches English street types, case-insensitive", () => {
		expect(isCanadianStreetWord("Street")).toBe(true)
		expect(isCanadianStreetWord("avenue")).toBe(true)
		expect(isCanadianStreetWord("Crescent")).toBe(true)
		expect(isCanadianStreetWord("Boulevard")).toBe(true)
	})

	it("matches French street types, case- and accent-insensitive", () => {
		expect(isCanadianStreetWord("Rue")).toBe(true)
		expect(isCanadianStreetWord("Chemin")).toBe(true)
		expect(isCanadianStreetWord("Côte")).toBe(true)
		expect(isCanadianStreetWord("cote")).toBe(true) // unaccented surface form
		expect(isCanadianStreetWord("Allée")).toBe(true)
	})

	it("rejects non-street words and non-strings", () => {
		expect(isCanadianStreetWord("Toronto")).toBe(false)
		expect(isCanadianStreetWord("Maple")).toBe(false)
		expect(isCanadianStreetWord(42)).toBe(false)
		expect(isCanadianStreetWord(null)).toBe(false)
	})
})

describe("isCanadianDirectional", () => {
	it("matches bare letters and full English words", () => {
		expect(isCanadianDirectional("N")).toBe(true)
		expect(isCanadianDirectional("North")).toBe(true)
		expect(isCanadianDirectional("NW")).toBe(true) // compound quadrant
		expect(isCanadianDirectional("se")).toBe(true)
	})

	it("matches the French words and the O = Ouest bilingual twist", () => {
		expect(isCanadianDirectional("Nord")).toBe(true)
		expect(isCanadianDirectional("Ouest")).toBe(true)
		expect(isCanadianDirectional("O")).toBe(true) // French Ouest abbreviates to O, not W
		expect(isCanadianDirectional("Est")).toBe(true)
	})

	it("rejects non-directional tokens and non-strings", () => {
		expect(isCanadianDirectional("Rue")).toBe(false)
		expect(isCanadianDirectional("XY")).toBe(false)
		expect(isCanadianDirectional(null)).toBe(false)
	})
})
