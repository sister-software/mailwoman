// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { countryOfInseeCode } from "#fr/insee-country"

describe("countryOfInseeCode", () => {
	it.each([
		["97123", "GP"],
		["97216", "MQ"],
		["97390", "GF"],
		["97412", "RE"],
		["97501", "PM"],
		["97630", "YT"],
		["97701", "BL"],
		["97801", "MF"],
		["984", "TF"],
		["986", "WF"],
		["98735", "PF"],
		["98825", "NC"],
		// A metropolitan department is two characters, Corsica's included, and neither reads as overseas.
		["75101", "FR"],
		["2A004", "FR"],
		// Clipperton has no ISO 3166-1 alpha-2 code, so `989` stays metropolitan rather than guessing.
		["98901", "FR"],
		["", "FR"],
	])("reads %s as %s", (code, expected) => {
		expect(countryOfInseeCode(code)).toBe(expected)
	})

	it("reads a code whose publisher padded it", () => {
		expect(countryOfInseeCode(" 97216 ")).toBe("MQ")
	})
})
