/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { isUsStateAbbreviation, US_STATE_ABBREVIATIONS, US_STATE_BY_ABBREVIATION, US_STATE_NAMES } from "./state.js"

test("isUsStateAbbreviation: true for a sample of states, DC, and territories", () => {
	for (const abbr of ["CA", "NY", "TX", "AK", "HI", "DC", "PR", "GU", "VI", "MP", "AS"]) {
		expect(isUsStateAbbreviation(abbr)).toBe(true)
	}
})

test("isUsStateAbbreviation: case-insensitive (abbreviation arrives from raw address text)", () => {
	expect(isUsStateAbbreviation("ca")).toBe(true)
	expect(isUsStateAbbreviation("Ny")).toBe(true)
	expect(isUsStateAbbreviation("tX")).toBe(true)
})

test("isUsStateAbbreviation: false for non-state / malformed / non-string input", () => {
	expect(isUsStateAbbreviation("XX")).toBe(false)
	expect(isUsStateAbbreviation("California")).toBe(false) // full name, not abbreviation
	expect(isUsStateAbbreviation("CAL")).toBe(false)
	expect(isUsStateAbbreviation("C")).toBe(false)
	expect(isUsStateAbbreviation(" CA ")).toBe(false) // predicate does not trim
	expect(isUsStateAbbreviation("")).toBe(false)
	expect(isUsStateAbbreviation(42)).toBe(false)
	expect(isUsStateAbbreviation(null)).toBe(false)
	expect(isUsStateAbbreviation(undefined)).toBe(false)
})

test("US_STATE_BY_ABBREVIATION: abbreviation → full name, including homographs and territories", () => {
	expect(US_STATE_BY_ABBREVIATION.CA).toBe("California")
	expect(US_STATE_BY_ABBREVIATION.GA).toBe("Georgia") // country/state homograph
	expect(US_STATE_BY_ABBREVIATION.WA).toBe("Washington") // country-capital homograph
	expect(US_STATE_BY_ABBREVIATION.DC).toBe("District of Columbia")
	expect(US_STATE_BY_ABBREVIATION.NY).toBe("New York")
	expect(US_STATE_BY_ABBREVIATION.PR).toBe("Puerto Rico")
	expect(US_STATE_BY_ABBREVIATION.VI).toBe("US Virgin Islands")
	expect(US_STATE_BY_ABBREVIATION.MP).toBe("Northern Mariana Islands")
})

test("US_STATE_ABBREVIATIONS: holds 56 entries (50 states + DC + 5 territories, complete + unique)", () => {
	expect(US_STATE_ABBREVIATIONS).toHaveLength(56)
	expect(new Set(US_STATE_ABBREVIATIONS).size).toBe(56) // no duplicates
})

test("every abbreviation has a name, and every abbreviation in the list keys the name map", () => {
	expect(Object.keys(US_STATE_BY_ABBREVIATION)).toHaveLength(US_STATE_ABBREVIATIONS.length)
	for (const abbr of US_STATE_ABBREVIATIONS) {
		expect(US_STATE_BY_ABBREVIATION[abbr]).toBeTruthy()
	}
})

test("US_STATE_NAMES: derived from the name map, one name per abbreviation", () => {
	expect(US_STATE_NAMES).toHaveLength(US_STATE_ABBREVIATIONS.length)
	expect(US_STATE_NAMES).toContain("California")
	expect(US_STATE_NAMES).toContain("Georgia")
	expect(US_STATE_NAMES).toContain("Washington")
	expect(US_STATE_NAMES).not.toContain("Narnia")
})
