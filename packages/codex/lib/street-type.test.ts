/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { streetTypeWordTestFor } from "#street/type"

describe("streetTypeWordTestFor", () => {
	it("reads the USPS abbreviations and directionals the morphology FST omits", () => {
		const us = streetTypeWordTestFor("US")

		expect(us("St")).toBe(true)
		expect(us("rd")).toBe(true)
		expect(us("NW")).toBe(true)
		expect(us("Building")).toBe(false)
		expect(us("School")).toBe(false)
	})

	it("reads each country through its own table, case-insensitively on the code", () => {
		expect(streetTypeWordTestFor("fr")("Rue")).toBe(true)
		expect(streetTypeWordTestFor("GB")("Mews")).toBe(true)
		expect(streetTypeWordTestFor("DE")("Hauptstraße")).toBe(true)
		expect(streetTypeWordTestFor("CA")("Chemin")).toBe(true)
	})

	it("accepts no word for a country without a table, and for no country", () => {
		expect(streetTypeWordTestFor("JM")("Avenue")).toBe(false)
		expect(streetTypeWordTestFor(null)("St")).toBe(false)
	})
})
