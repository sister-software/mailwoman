/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { formatAddress, toOpenCageComponents } from "./format.js"

describe("formatAddress", () => {
	it("renders a canonical US address across newlines by default (no country line when 'country' is absent)", () => {
		const out = formatAddress(
			{
				house_number: "1600",
				street: "Pennsylvania Ave NW",
				locality: "Washington",
				region: "DC",
				postcode: "20500",
			},
			"US"
		)
		expect(out).toBe("1600 Pennsylvania Ave NW\nWashington, DC 20500")
	})

	it("collapses to a single line when separator is given", () => {
		const out = formatAddress(
			{
				house_number: "1600",
				street: "Pennsylvania Ave NW",
				locality: "Washington",
				region: "DC",
				postcode: "20500",
			},
			"US",
			{ separator: ", " }
		)
		expect(out).toBe("1600 Pennsylvania Ave NW, Washington, DC 20500")
	})

	it("renders a canonical FR address with FR template ordering", () => {
		const out = formatAddress(
			{
				house_number: "10",
				street_prefix: "Rue",
				street_prefix_particle: "de la",
				street: "République",
				locality: "Paris",
				postcode: "75008",
			},
			"FR"
		)
		expect(out).toBe("10 Rue de la République\n75008 Paris")
	})

	it("folds cedex into postcode for FR", () => {
		const out = formatAddress(
			{
				street_prefix: "Avenue",
				street_prefix_particle: "des",
				street: "Champs-Élysées",
				locality: "Paris",
				postcode: "75008",
				cedex: "CEDEX 08",
			},
			"FR",
			{ separator: ", " }
		)
		expect(out).toContain("75008 CEDEX 08")
		expect(out).toContain("Avenue des Champs-Élysées")
	})

	it("renders a PO box for US", () => {
		const out = formatAddress(
			{
				po_box: "PO Box 123",
				locality: "Portland",
				region: "OR",
				postcode: "97215",
			},
			"US"
		)
		expect(out).toContain("PO Box 123")
		expect(out).toContain("Portland, OR 97215")
	})

	it("renders an intersection as 'A & B'", () => {
		const out = formatAddress(
			{
				intersection_a: "Main St",
				intersection_b: "5th Ave",
				locality: "Portland",
				region: "OR",
			},
			"US",
			{ separator: ", " }
		)
		expect(out).toBe("Main St & 5th Ave, Portland, OR")
	})

	it("appends unit to the road line", () => {
		const out = formatAddress(
			{
				house_number: "1600",
				street: "Pennsylvania Ave NW",
				unit: "Apt 4B",
				locality: "Washington",
				region: "DC",
				postcode: "20500",
			},
			"US",
			{ separator: ", " }
		)
		expect(out).toBe("1600 Pennsylvania Ave NW Apt 4B, Washington, DC 20500")
	})

	it("appendCountry: true adds the country line", () => {
		const out = formatAddress(
			{
				house_number: "1600",
				street: "Pennsylvania Ave NW",
				locality: "Washington",
				region: "DC",
				postcode: "20500",
				country: "United States of America",
			},
			"US",
			{ appendCountry: true, separator: ", " }
		)
		expect(out).toMatch(/United States of America$/u)
	})

	it("abbreviate: true shrinks at least one OpenCage-known token", () => {
		const noAbbr = formatAddress(
			{
				house_number: "1600",
				street: "Pennsylvania Avenue",
				locality: "Washington",
				region: "DC",
				postcode: "20500",
			},
			"US",
			{ separator: ", ", abbreviate: false }
		)
		const withAbbr = formatAddress(
			{
				house_number: "1600",
				street: "Pennsylvania Avenue",
				locality: "Washington",
				region: "DC",
				postcode: "20500",
			},
			"US",
			{ separator: ", ", abbreviate: true }
		)
		expect(noAbbr).toContain("Avenue")
		// US template's abbreviate rules turn "Avenue" into "Ave". Don't assert the exact
		// transformation set — the OpenCage table evolves — only that something shrank.
		expect(withAbbr.length).toBeLessThan(noAbbr.length)
		expect(withAbbr).not.toContain("Avenue")
	})

	it("returns empty string when every component is empty", () => {
		expect(formatAddress({}, "US")).toBe("")
	})

	it("trims trailing whitespace", () => {
		const out = formatAddress({ locality: "Paris" }, "FR")
		expect(out).toBe(out.trimEnd())
	})
})

describe("toOpenCageComponents", () => {
	it("translates ComponentTag keys to OpenCage keys", () => {
		const oc = toOpenCageComponents(
			{
				house_number: "1600",
				street: "Pennsylvania Ave NW",
				locality: "Washington",
				dependent_locality: "Foggy Bottom",
				region: "DC",
				subregion: "District of Columbia",
				postcode: "20500",
			},
			"US"
		)
		expect(oc).toEqual({
			house_number: "1600",
			road: "Pennsylvania Ave NW",
			city: "Washington",
			suburb: "Foggy Bottom",
			state: "DC",
			county: "District of Columbia",
			postcode: "20500",
			country_code: "us",
		})
	})

	it("lowercases the country code", () => {
		const oc = toOpenCageComponents({ locality: "Lyon" }, "FR")
		expect(oc.country_code).toBe("fr")
	})

	it("omits empty / undefined components", () => {
		const oc = toOpenCageComponents({ locality: "Paris" }, "FR")
		expect(oc).toEqual({ city: "Paris", country_code: "fr" })
	})
})
