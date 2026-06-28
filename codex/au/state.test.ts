/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { AU_STATE_ABBREVIATIONS, isAuStateAbbreviation } from "./state.js"

test("AU_STATE_ABBREVIATIONS: the eight ISO 3166-2:AU subdivisions map to their full names", () => {
	expect(AU_STATE_ABBREVIATIONS.NSW).toBe("New South Wales")
	expect(AU_STATE_ABBREVIATIONS.VIC).toBe("Victoria")
	expect(AU_STATE_ABBREVIATIONS.QLD).toBe("Queensland")
	expect(AU_STATE_ABBREVIATIONS.WA).toBe("Western Australia")
	expect(AU_STATE_ABBREVIATIONS.SA).toBe("South Australia")
	expect(AU_STATE_ABBREVIATIONS.TAS).toBe("Tasmania")
	expect(AU_STATE_ABBREVIATIONS.ACT).toBe("Australian Capital Territory")
	expect(AU_STATE_ABBREVIATIONS.NT).toBe("Northern Territory")
	// exactly six states + two territories
	expect(Object.keys(AU_STATE_ABBREVIATIONS)).toHaveLength(8)
})

test("isAuStateAbbreviation: true for every abbreviation in the set", () => {
	for (const abbr of Object.keys(AU_STATE_ABBREVIATIONS)) {
		expect(isAuStateAbbreviation(abbr)).toBe(true)
	}
})

test("isAuStateAbbreviation: case-insensitive (abbreviations arrive from raw text)", () => {
	expect(isAuStateAbbreviation("nsw")).toBe(true)
	expect(isAuStateAbbreviation("vic")).toBe(true)
	expect(isAuStateAbbreviation("Qld")).toBe(true)
	expect(isAuStateAbbreviation("wA")).toBe(true)
})

test("isAuStateAbbreviation: false for non-AU / malformed / non-string input", () => {
	expect(isAuStateAbbreviation("CA")).toBe(false) // US abbreviation
	expect(isAuStateAbbreviation("New South Wales")).toBe(false) // full name, not abbreviation
	expect(isAuStateAbbreviation("NSWX")).toBe(false)
	expect(isAuStateAbbreviation("")).toBe(false)
	expect(isAuStateAbbreviation("  NSW  ")).toBe(false) // not trimmed by the predicate
	expect(isAuStateAbbreviation(123)).toBe(false)
	expect(isAuStateAbbreviation(null)).toBe(false)
	expect(isAuStateAbbreviation(undefined)).toBe(false)
})
