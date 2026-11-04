// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { StreetLocalityEvidence } from "@mailwoman/resolver"
import { describe, expect, it } from "vitest"

import { splitTrailingUnit, unitVocabularyFor } from "#adapters/street/unit"

/**
 * A street index that holds the given street names for one country.
 */
function index(country: string, ...streets: string[]): StreetLocalityEvidence {
	const names = new Set(streets.map((street) => street.toLowerCase()))

	return { countries: new Set([country]), hasStreetName: (surface) => names.has(surface.toLowerCase()) }
}

async function split(street: string, country: string, evidence?: StreetLocalityEvidence) {
	return splitTrailingUnit(street, { vocabulary: await unitVocabularyFor(country), evidence: evidence ?? null })
}

describe("splitTrailingUnit", () => {
	it("splits a US unit when the street ends in a street-type word or a number", async () => {
		expect(await split("Memorial Dr Unit 3029", "US")).toEqual({
			street: "Memorial Dr",
			unit: "Unit 3029",
			admittedBy: "street-word",
		})

		expect(await split("N STATE HWY 360 APT 433", "US")).toEqual({
			street: "N STATE HWY 360",
			unit: "APT 433",
			admittedBy: "number",
		})

		expect(await split("Main St, Apartment 200", "US")).toMatchObject({ street: "Main St", unit: "Apartment 200" })
		// A trailing directional is stepped over to the type word or number before it.
		expect(await split("HIGHWAY 6 N # 174", "US")).toMatchObject({ street: "HIGHWAY 6 N", admittedBy: "number" })
		expect(await split("CROWN RD SW # 16709", "US")).toMatchObject({ street: "CROWN RD SW", admittedBy: "street-word" })
	})

	it("reads the number sign as a unit where the country's table lists it, apart or joined", async () => {
		expect(await split("LAWRENCE EXPY # 190", "US")).toMatchObject({ street: "LAWRENCE EXPY", unit: "# 190" })
		expect(await split("SEMINARY RD #120", "US")).toMatchObject({ street: "SEMINARY RD", unit: "#120" })
		expect(await split("SOUTHWEST PKWY SUITE # 200", "US")).toMatchObject({ unit: "SUITE # 200" })
	})

	it("splits a designator joined to its number, and two units as one", async () => {
		expect(await split("HAYDEN RD SUITE26", "US")).toMatchObject({ street: "HAYDEN RD", unit: "SUITE26" })

		expect(await split("ROSS AVE. BLDG2 SUITE207B", "US")).toMatchObject({
			street: "ROSS AVE.",
			unit: "BLDG2 SUITE207B",
		})
	})

	it("keeps a joined token whose identifier is a whole postcode of the country", async () => {
		expect(await split("SW 92ND AVE BAY FL33157", "US")).toBeNull()
	})

	it("keeps a city, region and postcode tail run into the street, and a directional that names the street", async () => {
		const vocabulary = await unitVocabularyFor("US")

		expect(splitTrailingUnit("TAMPA ROAD PALM HARBOR FL 34683", { vocabulary, postcode: "34683" })).toBeNull()

		expect(splitTrailingUnit("CROWN RD SW # 16709", { vocabulary, postcode: "30304-0001" })).toMatchObject({
			unit: "# 16709",
		})

		expect(splitTrailingUnit("Ocean Front S", { vocabulary })).toBeNull()
	})

	it("keeps a street that opens with a designator", async () => {
		expect(await split("PIER 39", "US")).toBeNull()
		expect(await split("SUITE B WESTGATE DRIVE", "US")).toBeNull()
	})

	it("splits a French building only when the street index holds the remaining street", async () => {
		const ban = index("FR", "Rue du General Charles de Gaulle")

		expect(await split("Rue du General Charles de Gaulle Bat B", "FR", ban)).toEqual({
			street: "Rue du General Charles de Gaulle",
			unit: "Bat B",
			admittedBy: "attested",
		})

		expect(await split("Rue du General Charles de Gaulle Bat B", "FR")).toBeNull()
		expect(await split("Chemin de la Tour D", "FR", ban)).toBeNull()
	})

	it("matches a two-letter designator only in capitals", async () => {
		const ban = index("FR", "rue victor Schoelcher Bat E", "RUE DE LA PAIX")

		expect(await split("rue victor Schoelcher Bat E et F", "FR", ban)).toBeNull()
		expect(await split("RUE DE LA PAIX ET 3", "FR", ban)).toMatchObject({ street: "RUE DE LA PAIX", unit: "ET 3" })
	})

	it("drops a dash between the street and the unit", async () => {
		const ban = index("FR", "Résidence Montrozier")

		expect(await split("Résidence Montrozier - Appartement 7", "FR", ban)).toMatchObject({
			street: "Résidence Montrozier",
			unit: "Appartement 7",
		})
	})

	it("reads another country's words only for that country", async () => {
		const italy = index("IT", "VIA REGINA MARGHERITA")

		expect(await split("VIA REGINA MARGHERITA SCALA C", "IT", italy)).toMatchObject({ unit: "SCALA C" })
		expect(await split("VIA REGINA MARGHERITA SCALA C", "FR", index("FR", "VIA REGINA MARGHERITA"))).toBeNull()
	})

	it("splits a floor written after its number in an unspaced street", async () => {
		expect(await split("武定路1101弄2楼", "CN")).toMatchObject({ street: "武定路1101弄", unit: "2楼" })
	})

	it("keeps an address-system level in the street line, in every country", async () => {
		// A block concept in codex: Brazil's Quadra and Mexico's Manzana.
		expect(await split("EDF QUADRA 6", "BR")).toBeNull()
		expect(await split("CALLE MANZANA 21", "MX")).toBeNull()
		// A row codex marks `partOfStreetLine`: Brasília's Conjunto and Mexico's Lote.
		expect(await split("EDF QR 603 CONJUNTO 8", "BR")).toBeNull()
		expect(await split("PRIVADA HIGUERAS LOTE 55", "MX")).toBeNull()
		// A word libpostal also lists among the language's street types: English `block`, read for Pakistan.
		expect(await split("DHA Phase 5 Block A", "PK")).toBeNull()
		// The US `LOT` of Publication 28 is a unit.
		expect(await split("Oquinn Rd Lot 214", "US")).toMatchObject({ street: "Oquinn Rd", unit: "Lot 214" })
	})

	it("reads libpostal's words for a country without a codex table", async () => {
		const vocabulary = await unitVocabularyFor("LV")

		expect(vocabulary.origin).toBe("libpostal")
		expect(vocabulary.prefix.size).toBeGreaterThan(0)
	})
})
