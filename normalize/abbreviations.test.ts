/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { expandAbbreviations } from "./abbreviations.js"

describe("expandAbbreviations — en-US", () => {
	it("expands street suffixes (St → Street)", () => {
		const r = expandAbbreviations("350 5th St")
		expect(r.text).toBe("350 5th Street")
		expect(r.expansions.length).toBe(1)
		expect(r.expansions[0]?.from).toBe("St")
		expect(r.expansions[0]?.to).toBe("Street")
	})

	it("expands street suffixes case-insensitively", () => {
		expect(expandAbbreviations("350 5th st").text).toBe("350 5th Street")
		expect(expandAbbreviations("350 5th ST").text).toBe("350 5th Street")
	})

	it("expands trailing-period abbreviations (St. → Street)", () => {
		const r = expandAbbreviations("350 5th St.")
		expect(r.text).toBe("350 5th Street")
		expect(r.expansions[0]?.from).toBe("St.")
	})

	it("expands multiple abbreviations in one string", () => {
		const r = expandAbbreviations("1600 Pennsylvania Ave NW")
		expect(r.text).toBe("1600 Pennsylvania Avenue Northwest")
		expect(r.expansions.length).toBe(2)
	})

	it("preserves non-abbreviation tokens", () => {
		const r = expandAbbreviations("350 5th Avenue")
		expect(r.text).toBe("350 5th Avenue")
		expect(r.expansions.length).toBe(0)
	})

	it("preserves punctuation between tokens", () => {
		const r = expandAbbreviations("350 5th Ave, NYC")
		expect(r.text).toBe("350 5th Avenue, NYC")
	})

	it("offsetMap points back to the source token start", () => {
		const r = expandAbbreviations("Ave")
		expect(r.text).toBe("Avenue")
		// All expanded chars point to position 0..2 of "Ave" (with last 3 chars all pointing at 2)
		expect(r.map[0]).toBe(0) // A
		expect(r.map[1]).toBe(1) // v
		expect(r.map[2]).toBe(2) // e
		expect(r.map[3]).toBe(2) // n (inserted; clamped to last source char)
		expect(r.map[4]).toBe(2) // u (inserted)
		expect(r.map[5]).toBe(2) // e (inserted)
	})
})

describe("expandAbbreviations — fr-FR", () => {
	it("expands French street abbreviations", () => {
		const r = expandAbbreviations("8 R République", "fr-FR")
		expect(r.text).toBe("8 Rue République")
		expect(r.expansions.length).toBe(1)
	})

	it("expands Bd → Boulevard", () => {
		const r = expandAbbreviations("Bd Saint-Michel", "fr-FR")
		expect(r.text).toBe("Boulevard Saint-Michel")
	})
})

describe("expandAbbreviations — no-ops", () => {
	it("leaves unknown words alone", () => {
		const r = expandAbbreviations("Bonjour Mailwoman")
		expect(r.text).toBe("Bonjour Mailwoman")
		expect(r.expansions.length).toBe(0)
	})

	it("handles empty input", () => {
		const r = expandAbbreviations("")
		expect(r.text).toBe("")
		expect(r.expansions.length).toBe(0)
	})
})
