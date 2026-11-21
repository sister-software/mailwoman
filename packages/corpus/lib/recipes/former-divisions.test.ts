// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The former-divisions row: the division sits before or after the locality, the postcode where the
 *   country writes it, and every component the row states is a span of its text.
 */

import { describe, expect, it } from "vitest"

import { type FormerDivisionTuple, formerDivisionRow } from "#recipes/former-divisions"

const AVON: FormerDivisionTuple = {
	country: "GB",
	division: "Avon",
	division_tag: "subregion",
	division_id: "geonames:2656749",
	settlement_id: 1_175_612_699,
	locality: "Bristol",
	dependent_locality: "Redland",
	postcode: null,
	postcode_placement: null,
	country_name: null,
	shape: "division_first",
	index: 0,
}

describe("formerDivisionRow", () => {
	it("writes the division before the locality in Google's order", () => {
		expect(formerDivisionRow(AVON)).toEqual({
			raw: "Redland, Avon, Bristol",
			components: { dependent_locality: "Redland", subregion: "Avon", locality: "Bristol" },
		})
	})

	it("writes the division after the locality, with a trailing postcode and country", () => {
		const row = formerDivisionRow({
			...AVON,
			shape: "division_after",
			dependent_locality: null,
			postcode: "BS6",
			postcode_placement: "after_locality",
			country_name: "United Kingdom",
		})

		expect(row.raw).toBe("Bristol BS6, Avon, United Kingdom")

		expect(row.components).toEqual({
			locality: "Bristol",
			subregion: "Avon",
			postcode: "BS6",
			country: "United Kingdom",
		})
	})

	it("puts a leading postcode before the locality", () => {
		const row = formerDivisionRow({
			...AVON,
			country: "FR",
			division: "Seine-et-Oise",
			division_tag: "region",
			locality: "Versailles",
			dependent_locality: null,
			postcode: "78000",
			postcode_placement: "leading",
		})

		expect(row.raw).toBe("Seine-et-Oise, 78000 Versailles")
	})
})
