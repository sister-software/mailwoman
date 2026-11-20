// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { AU_STATE_ABBREVIATIONS, isAuStateAbbreviation } from "#au"

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
	expect(isAuStateAbbreviation("New South Wales")).toBe(false) // full name rather than abbreviation
	expect(isAuStateAbbreviation("NSWX")).toBe(false)
	expect(isAuStateAbbreviation("")).toBe(false)
	expect(isAuStateAbbreviation("  NSW  ")).toBe(false) // not trimmed by the predicate
	expect(isAuStateAbbreviation(123)).toBe(false)
	expect(isAuStateAbbreviation(null)).toBe(false)
	expect(isAuStateAbbreviation(undefined)).toBe(false)
})
