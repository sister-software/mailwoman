// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { createUnitSplitter } from "#adapters/street/unit"
import { componentFindings, ComponentRule } from "#build/component-check"

const rules = (components: Record<string, string>, country = "US") =>
	componentFindings(components, country).map((finding) => finding.rule)

describe("componentFindings", () => {
	it("reports a postcode without its country's form, and only where the country states one", () => {
		// `1811 Hayes Avenue, Hull, IA IA`
		expect(
			rules({ house_number: "1811", street: "Hayes Avenue", locality: "Hull", region: "IA", postcode: "IA" })
		).toEqual([ComponentRule.PostcodeFormat, ComponentRule.PostcodeRepeatsRegion])

		expect(rules({ street: "Main St", locality: "Hull", region: "IA", postcode: "51239" })).toEqual([])
		// The United Arab Emirates records no postcode system, so a value there's not judged.
		expect(rules({ street: "Sheikh Zayed Rd", postcode: "12345" }, "AE")).toEqual([])
	})

	it("reports a street that ends in the row's own postcode", () => {
		expect(
			rules({ street: "MAPLE AVE # 90014", locality: "LOS ANGELES", region: "CA", postcode: "900142211" })
		).toEqual([ComponentRule.StreetRepeatsPostcode])

		expect(rules({ street: "MAPLE AVE # 190", locality: "LOS ANGELES", region: "CA", postcode: "900142211" })).toEqual(
			[]
		)
	})

	it("reports a street that ends in the row's own locality and region", () => {
		expect(
			rules({
				street: "GREENWOOD BLVD SUITE 1030 LAKE MARY FL 32746",
				locality: "LAKE MARY",
				region: "FL",
				postcode: "32746",
			})
		).toContain(ComponentRule.StreetHoldsPlace)

		expect(rules({ street: "LAKE MARY BLVD", locality: "LAKE MARY", region: "FL", postcode: "32746" })).toEqual([])
	})

	it("reports a locality that holds the row's house number and street, and nothing that only shares words", () => {
		// `56 East Chase Street, 56 East Chase Street, FL 32502`
		expect(
			rules({ house_number: "56", street: "East Chase Street", locality: "56 East Chase Street", region: "FL" })
		).toEqual([ComponentRule.LocalityHoldsStreet])

		// A village whose only street has the village's name, and a locality that shares a road's words, are ordinary.
		expect(
			rules({ house_number: "54/54", street: "Malý Šariš", locality: "Malý Šariš", postcode: "08001" }, "SK")
		).toEqual([])

		expect(rules({ house_number: "15", street: "Fox Park Road", locality: "Fox Park CDP", region: "WY" })).toEqual([])
		expect(rules({ street: "Lake Forest Dr", locality: "Lake Forest", region: "IL" })).toEqual([])
	})

	it("reports a postcode that is the row's own region", () => {
		expect(
			rules({ house_number: "1811", street: "Hayes Avenue", locality: "Hull", region: "IA", postcode: "IA" })
		).toContain(ComponentRule.PostcodeRepeatsRegion)

		// A country without a postcode syntax is still read, because the rule compares the row with itself.
		expect(rules({ locality: "Dubai", region: "DU", postcode: "du" }, "AE")).toEqual([
			ComponentRule.PostcodeRepeatsRegion,
		])
	})

	it("reports a locality written as its region's code, and leaves a city named like its region", () => {
		// `Lisa Jordan, 1819 Grand Valley Dr, HOUSTON, TX, TX 77090`, read with `TX` as the city.
		expect(rules({ street: "Grand Valley Dr", locality: "TX", region: "TX", postcode: "77090" })).toEqual([
			ComponentRule.LocalityRepeatsRegion,
		])

		expect(rules({ street: "Meadow Lark", locality: "Tx", region: "Texas", postcode: "76532" })).toEqual([
			ComponentRule.LocalityRepeatsRegion,
		])

		expect(rules({ street: "Broadway", locality: "New York", region: "NY", postcode: "10001" })).toEqual([])

		expect(rules({ street: "Rua Augusta", locality: "São Paulo", region: "SP", postcode: "01305-000" }, "BR")).toEqual(
			[]
		)

		// The Emirates key Abu Dhabi by its name, beside ISO code `AZ`, so the city
		// of Abu Dhabi in its emirate is ordinary.
		expect(rules({ locality: "أبو ظبي", region: "أبو ظبي" }, "AE")).toEqual([])

		// Germany's libaddressinput spec keys its states by name, so no code is judged there.
		expect(
			rules({ street: "Unter den Linden", locality: "Berlin", region: "Berlin", postcode: "10117" }, "DE")
		).toEqual([])
	})

	it("reports a street that still ends in a unit, in the words of the row's country", async () => {
		const units = await createUnitSplitter()

		const unitRules = (components: Record<string, string>, country: string) =>
			componentFindings(components, country, { units }).map((finding) => finding.rule)

		// The splitter refused these: neither `N Mesa` nor `Avenue des Armieres` ends in a street word or a number.
		expect(unitRules({ street: "N Mesa Apt 266", locality: "El Paso", region: "TX", postcode: "79912" }, "US")).toEqual(
			[ComponentRule.StreetTrailingUnit]
		)

		expect(
			unitRules({ street: "Avenue des Armieres Entree 13", locality: "Villefontaine", postcode: "38090" }, "FR")
		).toEqual([ComponentRule.StreetTrailingUnit])

		// A street that opens with a designator, or ends in the row's ZIP Code, holds no unit.
		expect(unitRules({ street: "Pier 39", locality: "San Francisco", region: "CA", postcode: "94133" }, "US")).toEqual(
			[]
		)

		expect(unitRules({ street: "MAPLE AVE # 90014", region: "CA", postcode: "900142211" }, "US")).toEqual([
			ComponentRule.StreetRepeatsPostcode,
		])

		// Without the vocabulary the rule isn't read.
		expect(rules({ street: "N Mesa Apt 266", locality: "El Paso", region: "TX", postcode: "79912" })).toEqual([])
	})
})
