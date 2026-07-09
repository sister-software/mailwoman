/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { DE_STREET_SUFFIXES, isGermanStreetToken } from "./street-type.ts"

describe("isGermanStreetToken", () => {
	it("matches fused compound streets via their suffix", () => {
		expect(isGermanStreetToken("Straußstraße")).toBe(true)
		expect(isGermanStreetToken("Karl-Liebknecht-Straße")).toBe(true) // hyphen stripped, ends straße
		expect(isGermanStreetToken("Hauptstrasse")).toBe(true) // ss spelling
		expect(isGermanStreetToken("Schlossallee")).toBe(true)
		expect(isGermanStreetToken("Rosenweg")).toBe(true)
	})

	it("matches the standalone type word and the Str. abbreviation", () => {
		expect(isGermanStreetToken("Platz")).toBe(true)
		expect(isGermanStreetToken("Str.")).toBe(true) // punctuation stripped → "str"
	})

	it("does NOT flag city names that merely end in a place-name suffix", () => {
		// The collision guard: -berg/-burg/-dorf/-feld are excluded so a city token in a `PLZ City`
		// segment is not mistaken for a street.
		expect(isGermanStreetToken("Nürnberg")).toBe(false)
		expect(isGermanStreetToken("Hamburg")).toBe(false)
		expect(isGermanStreetToken("Düsseldorf")).toBe(false)
		expect(isGermanStreetToken("Bielefeld")).toBe(false)
		expect(isGermanStreetToken("Berlin")).toBe(false)
	})

	it("rejects non-strings and too-short tokens", () => {
		expect(isGermanStreetToken(123)).toBe(false)
		expect(isGermanStreetToken("am")).toBe(false)
	})
})

describe("DE_STREET_SUFFIXES", () => {
	it("carries both ß and ss spellings of Straße and excludes place-name suffixes", () => {
		expect(DE_STREET_SUFFIXES).toContain("straße")
		expect(DE_STREET_SUFFIXES).toContain("strasse")
		expect(DE_STREET_SUFFIXES).not.toContain("berg")
		expect(DE_STREET_SUFFIXES).not.toContain("burg")
	})
})
