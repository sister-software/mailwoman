// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { readNZCharity } from "#nz/evaluation/charities-register"

// Rows from the OData CSV as served on 2026-11-14, keys as the CSV reader normalizes them.
const row = (line2: string, suburb = " ") => ({
	charity_registration_number: "CC49414",
	street_address_city: "Waipukurau",
	street_address_country: "",
	street_address_line1: "72 Racecourse Road",
	street_address_line2: line2,
	street_address_postcode: "4200",
	street_address_suburb: suburb,
})

describe("readNZCharity", () => {
	it("keeps a second line that repeats the city and postcode", () => {
		expect(readNZCharity(row("Waipukurau 4200"))).toEqual({
			id: "CC49414",
			stratum: "postcode 4",
			components: { house_number: "72", street: "Racecourse Road", locality: "Waipukurau", postcode: "4200" },
		})
	})

	it("refuses a second line holding another address or a rural delivery code", () => {
		expect(readNZCharity(row("98 Birch Avenue"))).toEqual({ refused: "row:several-lines" })
		expect(readNZCharity(row("RD 3"))).toEqual({ refused: "row:several-lines" })
	})

	it("labels a suburb distinct from the city as a dependent locality", () => {
		expect(readNZCharity(row("", "Otane"))).toMatchObject({ components: { dependent_locality: "Otane" } })
	})
})
