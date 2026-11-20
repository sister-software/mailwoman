// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { lookupFipsState, lookupStateAbbreviation, US_FIPS_STATE, US_STATE_BY_ABBREVIATION } from "#us/fips-state"

// #region US_FIPS_STATE table

test("US_FIPS_STATE: covers exactly 50 states + DC + 5 territories (56 entries)", () => {
	expect(Object.keys(US_FIPS_STATE)).toHaveLength(56)
})

test("US_FIPS_STATE: every abbreviation is unique", () => {
	const abbreviations = Object.values(US_FIPS_STATE).map((info) => info.abbreviation)
	expect(new Set(abbreviations).size).toBe(abbreviations.length)
})

test("US_FIPS_STATE: is frozen (immutable reference table)", () => {
	expect(Object.isFrozen(US_FIPS_STATE)).toBe(true)
})

// #endregion

// #region lookupFipsState

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
	expect(lookupFipsState(null)).toBeNull()
	expect(lookupFipsState("")).toBeNull()
})

test("lookupFipsState: the lookup is exact — a non-padded code does not match", () => {
	// tiger ships zero-padded `statefp` ("06"), so a bare "6" mustn't resolve to California.
	expect(lookupFipsState("6")).toBeNull()
})

// #endregion

// #region US_STATE_BY_ABBREVIATION (inverted view)

test("US_STATE_BY_ABBREVIATION: inverts the table by postal abbreviation", () => {
	expect(US_STATE_BY_ABBREVIATION.CA).toEqual({ abbreviation: "CA", name: "California" })
	expect(US_STATE_BY_ABBREVIATION.VT).toEqual({ abbreviation: "VT", name: "Vermont" })
	expect(US_STATE_BY_ABBREVIATION.PR).toEqual({ abbreviation: "PR", name: "Puerto Rico" })
})

test("US_STATE_BY_ABBREVIATION: has the same cardinality as the forward table", () => {
	expect(Object.keys(US_STATE_BY_ABBREVIATION)).toHaveLength(Object.keys(US_FIPS_STATE).length)
})

// #endregion

// #region lookupStateAbbreviation

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
	expect(lookupStateAbbreviation(null)).toBeNull()
	expect(lookupStateAbbreviation("")).toBeNull()
})

// #endregion
