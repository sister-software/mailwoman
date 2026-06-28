/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { lookupFipsState, lookupStateAbbreviation, US_FIPS_STATE, US_STATE_BY_ABBREVIATION } from "./us-fips-state.js"

//#region US_FIPS_STATE table

test("US_FIPS_STATE: maps zero-padded FIPS codes to the correct state", () => {
	expect(US_FIPS_STATE["01"]).toEqual({ abbreviation: "AL", name: "Alabama" })
	expect(US_FIPS_STATE["06"]).toEqual({ abbreviation: "CA", name: "California" })
	expect(US_FIPS_STATE["50"]).toEqual({ abbreviation: "VT", name: "Vermont" })
	expect(US_FIPS_STATE["36"]).toEqual({ abbreviation: "NY", name: "New York" })
})

test("US_FIPS_STATE: DC and the five primary territories are present", () => {
	expect(US_FIPS_STATE["11"]).toEqual({ abbreviation: "DC", name: "District of Columbia" })
	expect(US_FIPS_STATE["72"]).toEqual({ abbreviation: "PR", name: "Puerto Rico" })
	expect(US_FIPS_STATE["66"]).toEqual({ abbreviation: "GU", name: "Guam" })
	expect(US_FIPS_STATE["78"]).toEqual({ abbreviation: "VI", name: "Virgin Islands" })
	expect(US_FIPS_STATE["69"]).toEqual({ abbreviation: "MP", name: "Northern Mariana Islands" })
	expect(US_FIPS_STATE["60"]).toEqual({ abbreviation: "AS", name: "American Samoa" })
})

test("US_FIPS_STATE: covers exactly 50 states + DC + 5 territories (56 entries)", () => {
	expect(Object.keys(US_FIPS_STATE)).toHaveLength(56)
})

test("US_FIPS_STATE: the unassigned FIPS gaps (03, 07, 14, 43, 52) are absent", () => {
	for (const gap of ["03", "07", "14", "43", "52"]) {
		expect(US_FIPS_STATE[gap]).toBeUndefined()
	}
})

test("US_FIPS_STATE: every abbreviation is unique", () => {
	const abbreviations = Object.values(US_FIPS_STATE).map((info) => info.abbreviation)
	expect(new Set(abbreviations).size).toBe(abbreviations.length)
})

test("US_FIPS_STATE: is frozen (immutable reference table)", () => {
	expect(Object.isFrozen(US_FIPS_STATE)).toBe(true)
})

//#endregion

//#region lookupFipsState

test("lookupFipsState: resolves a known zero-padded code", () => {
	expect(lookupFipsState("50")).toEqual({ abbreviation: "VT", name: "Vermont" })
	expect(lookupFipsState("48")).toEqual({ abbreviation: "TX", name: "Texas" })
})

test("lookupFipsState: an unrecognized code returns null", () => {
	expect(lookupFipsState("99")).toBeNull()
	expect(lookupFipsState("03")).toBeNull()
})

test("lookupFipsState: null/undefined/empty input returns null", () => {
	expect(lookupFipsState(null)).toBeNull()
	expect(lookupFipsState(undefined)).toBeNull()
	expect(lookupFipsState("")).toBeNull()
})

test("lookupFipsState: the lookup is exact — a non-padded code does not match", () => {
	// TIGER ships zero-padded `statefp` ("06"), so a bare "6" must NOT resolve to California.
	expect(lookupFipsState("6")).toBeNull()
})

//#endregion

//#region US_STATE_BY_ABBREVIATION (inverted view)

test("US_STATE_BY_ABBREVIATION: inverts the table by postal abbreviation", () => {
	expect(US_STATE_BY_ABBREVIATION.CA).toEqual({ abbreviation: "CA", name: "California" })
	expect(US_STATE_BY_ABBREVIATION.VT).toEqual({ abbreviation: "VT", name: "Vermont" })
	expect(US_STATE_BY_ABBREVIATION.PR).toEqual({ abbreviation: "PR", name: "Puerto Rico" })
})

test("US_STATE_BY_ABBREVIATION: has the same cardinality as the forward table", () => {
	expect(Object.keys(US_STATE_BY_ABBREVIATION)).toHaveLength(Object.keys(US_FIPS_STATE).length)
})

//#endregion

//#region lookupStateAbbreviation

test("lookupStateAbbreviation: resolves an uppercase abbreviation", () => {
	expect(lookupStateAbbreviation("CA")).toEqual({ abbreviation: "CA", name: "California" })
	expect(lookupStateAbbreviation("DC")).toEqual({ abbreviation: "DC", name: "District of Columbia" })
})

test("lookupStateAbbreviation: is case-folded (lower/mixed case resolve)", () => {
	expect(lookupStateAbbreviation("ca")).toEqual({ abbreviation: "CA", name: "California" })
	expect(lookupStateAbbreviation("vT")).toEqual({ abbreviation: "VT", name: "Vermont" })
})

test("lookupStateAbbreviation: an unknown abbreviation returns null", () => {
	expect(lookupStateAbbreviation("ZZ")).toBeNull()
	expect(lookupStateAbbreviation("XX")).toBeNull()
})

test("lookupStateAbbreviation: null/undefined/empty input returns null", () => {
	expect(lookupStateAbbreviation(null)).toBeNull()
	expect(lookupStateAbbreviation(undefined)).toBeNull()
	expect(lookupStateAbbreviation("")).toBeNull()
})

//#endregion
