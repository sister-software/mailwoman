// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { formatAddress, formatAddressRow } from "#address/format"
import { dropAddressPunctuation, postalStyleForCountry } from "#address/postal-style"

const WHITE_HOUSE = {
	house_number: "1600",
	street: "Pennsylvania Ave. NW",
	locality: "Washington",
	region: "DC",
	postcode: "20500",
}

describe("the postal form", () => {
	it("prints a US address in upper case, without periods or commas, with two spaces before the ZIP Code", () => {
		expect(formatAddress(WHITE_HOUSE, "US", { postal: true, singleLine: true })).toBe(
			"1600 PENNSYLVANIA AVE NW WASHINGTON DC  20500"
		)
	})

	it("keeps the envelope's line breaks", () => {
		expect(formatAddress(WHITE_HOUSE, "US", { postal: true })).toBe("1600 PENNSYLVANIA AVE NW\nWASHINGTON DC  20500")
	})

	it("restyles the placed components alike, so each one's text still occurs in the rendered text", () => {
		const row = formatAddressRow(WHITE_HOUSE, "US", { postal: true, singleLine: true })!

		expect(row.components.street).toBe("PENNSYLVANIA AVE NW")

		for (const value of Object.values(row.components)) {
			expect(row.raw).toContain(value)
		}
	})

	it("takes an explicit casing over the country's recorded one", () => {
		expect(formatAddress(WHITE_HOUSE, "US", { postal: true, singleLine: true, casing: "lower" })).toBe(
			"1600 pennsylvania ave nw washington dc  20500"
		)

		expect(formatAddress(WHITE_HOUSE, "US", { postal: true, singleLine: true, casing: null })).toBe(
			"1600 Pennsylvania Ave NW Washington DC  20500"
		)
	})

	it("keeps a ZIP+4 hyphen and a unit's #", () => {
		const row = { ...WHITE_HOUSE, unit: "#4", postcode: "20500-0003" }

		expect(formatAddress(row, "US", { postal: true, singleLine: true })).toContain("#4")
		expect(formatAddress(row, "US", { postal: true, singleLine: true })).toMatch(/DC {2}20500-0003$/)
	})

	it("renders a country with no recorded style in its ordinary form, with the caller's casing", () => {
		const paris = { house_number: "10", street: "Rue de la Paix", locality: "Paris", postcode: "75002" }

		expect(postalStyleForCountry("FR")).toBeNull()

		expect(formatAddress(paris, "FR", { postal: true, singleLine: true })).toBe(
			formatAddress(paris, "FR", { singleLine: true })
		)

		expect(formatAddress(paris, "FR", { casing: "upper", singleLine: true })).toBe(
			formatAddress(paris, "FR", { singleLine: true }).toUpperCase()
		)
	})

	it("leaves the ordinary form unchanged when neither option is given", () => {
		expect(formatAddress(WHITE_HOUSE, "US", { singleLine: true })).toBe(
			"1600 Pennsylvania Ave. NW, Washington, DC 20500"
		)
	})
})

describe("dropAddressPunctuation", () => {
	it("replaces periods and commas with spaces and collapses them per line", () => {
		expect(dropAddressPunctuation("St. John's Rd.,  Apt 2\nSpringfield, IL")).toBe("St John's Rd Apt 2\nSpringfield IL")
	})
})
