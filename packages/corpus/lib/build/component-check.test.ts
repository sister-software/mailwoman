/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { componentFindings, ComponentRule } from "#build/component-check"

const rules = (components: Record<string, string>, country = "US") =>
	componentFindings(components, country).map((finding) => finding.rule)

describe("componentFindings", () => {
	it("reports a postcode without its country's form, and only where the country states one", () => {
		// `1811 Hayes Avenue, Hull, IA IA`
		expect(
			rules({ house_number: "1811", street: "Hayes Avenue", locality: "Hull", region: "IA", postcode: "IA" })
		).toEqual([ComponentRule.PostcodeFormat])

		expect(rules({ street: "Main St", locality: "Hull", region: "IA", postcode: "51239" })).toEqual([])
		// The United Arab Emirates records no postcode system, so a value there is not judged.
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
})
