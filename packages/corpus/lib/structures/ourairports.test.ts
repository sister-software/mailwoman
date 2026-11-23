// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { getPOICategory } from "@mailwoman/poi-taxonomy/lookup"
import { describe, expect, it } from "vitest"

import { ourAirportsStructureRecord } from "#structures/ourairports"

const HELIPORT = {
	ident: "00A",
	type: "heliport",
	name: "Total RF Heliport",
	latitude_deg: "40.070985",
	longitude_deg: "-74.933689",
	iso_country: "US",
}

describe("ourAirportsStructureRecord", () => {
	it("files an open site under its type's category and stamps its own country", () => {
		expect(ourAirportsStructureRecord(HELIPORT)).toEqual({
			id: "00A",
			name: "Total RF Heliport",
			category: "heliports",
			point: { latitude: 40.070985, longitude: -74.933689 },
			address: null,
			country: "US",
		})
	})

	it("yields no record for a closed site or a country code ISO 3166-1 doesn't assign", () => {
		expect(ourAirportsStructureRecord({ ...HELIPORT, type: "closed" })).toBeNull()
		expect(ourAirportsStructureRecord({ ...HELIPORT, iso_country: "XK" })).toBeNull()
	})

	it("refuses a type the table lacks rather than filing it under a guess", () => {
		expect(() => ourAirportsStructureRecord({ ...HELIPORT, type: "spaceport" })).toThrow(/spaceport/)
	})
})

describe("the open OurAirports types", () => {
	it("file each one under a category the POI taxonomy holds", () => {
		const types = ["large_airport", "medium_airport", "small_airport", "heliport", "seaplane_base", "balloonport"]

		for (const type of types) {
			const record = ourAirportsStructureRecord({ ...HELIPORT, type })

			expect(record?.category, type).toBeDefined()
			expect(getPOICategory(record?.category ?? ""), type).not.toBeNull()
		}
	})
})
