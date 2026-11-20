// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { countriesFromPostcodeFormat, countryFromPostcodeFormat } from "#postcode-format"

describe("countryFromPostcodeFormat", () => {
	it.each([
		["E4 9AZ", "GB"],
		["SW1A 1AA", "GB"],
		["IG5 0NA", "GB"],
		["E49AZ", "GB"],
		["  CH43 0TR  ", "GB"],
		["BT1 5GS", "GB"],
		["K2P 1L4", "CA"],
		["M5J 2J2", "CA"],
		["V6C0C3", "CA"],
		["D02 AF30", "IE"],
		["T12 X70A", "IE"],
		["V94T2XR", "IE"],
		["D6W XY00", "IE"],
		["D02 X285", "IE"],
		["A65 F4E2", "IE"],
		["D6W 1234", "IE"],
		["a65f4e2", "IE"],
	])("reads %s as %s", (postcode, country) => {
		expect(countryFromPostcodeFormat(postcode)).toBe(country)
	})

	it.each(["90210", "75013", "1012 LG", "110 00", "27", "2737 CA"])(
		"declines %s, which no single-country shape claims",
		(postcode) => {
			expect(countryFromPostcodeFormat(postcode)).toBeNull()
		}
	)

	// A seven-letter word fills libaddressinput's `[\dA-Z]{3} ?[\dA-Z]{4}`, and an Eircode never does (#3136).
	it.each(["Toronto", "Glasgow", "Chicago", "Bristol", "Hamburg", "Belfast"])(
		"declines the city name %s, which has no Eircode routing key",
		(postcode) => {
			expect(countryFromPostcodeFormat(postcode)).toBeNull()
		}
	)

	it.each(["D02 X2B5", "B12 F4E2", "D6X 1234"])(
		"declines %s, which holds a character outside the Eircode alphabet",
		(postcode) => {
			expect(countryFromPostcodeFormat(postcode)).toBeNull()
		}
	)

	it.each([undefined, null, "", "   "])("declines %s", (postcode) => {
		expect(countryFromPostcodeFormat(postcode)).toBeNull()
	})
})

describe("countriesFromPostcodeFormat", () => {
	it("returns the one country a single-country shape implies", () => {
		expect(countriesFromPostcodeFormat("E4 9AZ")).toEqual(["GB"])
	})

	it("returns NL for PC6, which the single-country list excludes as forgeable", () => {
		expect(countriesFromPostcodeFormat("1012 LG")).toEqual(["NL"])
		expect(countryFromPostcodeFormat("1012 LG")).toBeNull()
	})

	it("returns the four countries that share spaced NNN NN", () => {
		expect(countriesFromPostcodeFormat("110 00")).toEqual(["CZ", "SK", "SE", "GR"])
	})

	it("returns an empty list for a five-digit shape many countries share", () => {
		expect(countriesFromPostcodeFormat("12345")).toEqual([])
		expect(countriesFromPostcodeFormat("75013")).toEqual([])
	})

	it("excludes a US house number plus a directional, which matches the NL shape", () => {
		// `recognizeBarePostcode` reads this list, so a street fragment mustn't imply NL.
		// A caller applies this function only to a tree that's already a bare postcode, where `1234 NE`
		// as a whole tree is ambiguous, and the ZIP+4 shape claims `2737 CA` by longest match.
		expect(countryFromPostcodeFormat("1234 NE")).toBeNull()
	})
})
