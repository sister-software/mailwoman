/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ClassificationMap } from "@mailwoman/core/types"
import { describe, expect, it } from "vitest"

import {
	type ComponentDict,
	formatAddress,
	formatFromClassificationMap,
	injectDependentLocalityLine,
	reconcileComponents,
	toOpenCageComponents,
} from "./format.ts"

const US_ADDRESS: ComponentDict = {
	house_number: "123",
	street: "Main",
	street_suffix: "St",
	locality: "Portland",
	region: "OR",
	postcode: "97201",
}

describe("toOpenCageComponents", () => {
	it("maps the ComponentTag schema onto the OpenCage vocabulary", () => {
		expect(toOpenCageComponents(US_ADDRESS, "US")).toEqual({
			road: "Main St",
			house_number: "123",
			city: "Portland",
			state: "OR",
			postcode: "97201",
			country_code: "us",
		})
	})

	it("joins an intersection into the road field", () => {
		const oc = toOpenCageComponents({ intersection_a: "5th Ave", intersection_b: "Main St" }, "US")
		expect(oc.road).toBe("5th Ave & Main St")
	})

	it("folds FR cedex into the postcode slot", () => {
		const oc = toOpenCageComponents({ postcode: "75008", cedex: "CEDEX 08", locality: "Paris" }, "FR")
		expect(oc.postcode).toBe("75008 CEDEX 08")
	})

	it("rides the unit on the road line (no dedicated OpenCage slot)", () => {
		const oc = toOpenCageComponents({ street: "Pennsylvania", street_suffix: "Ave", unit: "Apt 4B" }, "US")
		expect(oc.road).toBe("Pennsylvania Ave Apt 4B")
	})

	it("never emits a bare country_code as the only component", () => {
		expect(toOpenCageComponents({}, "US")).toEqual({})
	})

	it("maps dependent_locality onto both suburb and quarter for GB (its template renders quarter)", () => {
		const oc = toOpenCageComponents({ dependent_locality: "Plaistow", locality: "Bromley" }, "GB")
		expect(oc.suburb).toBe("Plaistow")
		expect(oc.quarter).toBe("Plaistow")
	})

	it("maps dependent_locality onto suburb only for NZ (its template already renders suburb)", () => {
		const oc = toOpenCageComponents({ dependent_locality: "Ponsonby", locality: "Auckland" }, "NZ")
		expect(oc.suburb).toBe("Ponsonby")
		expect(oc.quarter).toBeUndefined()
	})

	it("maps dependent_locality onto place (in addition to suburb) for FR — its template renders a dedicated place line, not suburb/quarter", () => {
		const oc = toOpenCageComponents({ dependent_locality: "Les Chênes", locality: "Saint-Julien" }, "FR")
		expect(oc.place).toBe("Les Chênes")
	})

	it("leaves place unset for ES — its template has no standalone place/suburb/quarter line at all", () => {
		const oc = toOpenCageComponents({ dependent_locality: "Baranbio", locality: "Amurrio" }, "ES")
		expect(oc.place).toBeUndefined()
	})

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

describe("formatAddress", () => {
	it("renders an idiomatic single-line US address", () => {
		const formatted = formatAddress(US_ADDRESS, "US", { separator: ", " })

		expect(formatted).not.toContain("\n")

		for (const token of ["123", "Main", "Portland", "97201"]) {
			expect(formatted).toContain(token)
		}
	})

	it("returns an empty string for an empty dict", () => {
		expect(formatAddress({}, "US")).toBe("")
	})

	it("surfaces dependent_locality for GB — the template renders `quarter`, not `suburb`", () => {
		const formatted = formatAddress(
			{
				house_number: "2",
				street: "High Street",
				dependent_locality: "Plaistow",
				locality: "Bromley",
				postcode: "BR1 4AA",
			},
			"GB",
			{ separator: ", " }
		)

		expect(formatted).toContain("Plaistow")

		// Plaistow (the quarter/sub-locality) renders before Bromley (the locality) per the GB template order.
		expect(formatted.indexOf("Plaistow")).toBeLessThan(formatted.indexOf("Bromley"))
	})

	it("still surfaces dependent_locality for NZ — the template renders `suburb` directly", () => {
		const formatted = formatAddress(
			{
				house_number: "12",
				street: "Queen Street",
				dependent_locality: "Ponsonby",
				locality: "Auckland",
				postcode: "1011",
			},
			"NZ",
			{ separator: ", " }
		)

		expect(formatted).toContain("Ponsonby")
	})

	it("is unaffected for a country without dependent_locality (US)", () => {
		const formatted = formatAddress(US_ADDRESS, "US", { separator: ", " })

		for (const token of ["123", "Main", "Portland", "97201"]) {
			expect(formatted).toContain(token)
		}
	})

	it("surfaces dependent_locality for FR — the template has neither suburb nor quarter, but a standalone place line", () => {
		const formatted = formatAddress(
			{
				house_number: "12",
				street: "Rue de la Paix",
				dependent_locality: "Les Chênes",
				locality: "Saint-Julien",
				postcode: "38000",
			},
			"FR",
			{ separator: ", " }
		)

		expect(formatted).toContain("Les Chênes")

		// Lieu-dit customarily sits directly above the postcode+town line (La Poste's addressing guide, line 5 of
		// 6) — matches where the FR template's own {{{place}}} line falls, above the {{{postcode}}} {{{town}}} line.
		expect(formatted.indexOf("Les Chênes")).toBeLessThan(formatted.indexOf("Saint-Julien"))
	})

	it("surfaces dependent_locality for ES — the template has no native slot at all (post-render fallback)", () => {
		const formatted = formatAddress(
			{
				house_number: "35",
				street: "Carretera A-2522",
				dependent_locality: "Baranbio",
				locality: "Amurrio",
				region: "País Vasco",
				postcode: "01450",
			},
			"ES",
			{ separator: ", " }
		)

		expect(formatted).toContain("Baranbio")

		// The pedanía (below-municipio place name) sits above the municipio in real Spanish addressing usage —
		// e.g. Correos's own examples list the núcleo/entidad-de-población line directly above the
		// "postcode municipio" line (the same position OpenCage's own ES fallback_template uses for {{{place}}}
		// and {{{suburb}}}, even though the primary template never reaches it).
		expect(formatted.indexOf("Baranbio")).toBeLessThan(formatted.indexOf("Amurrio"))
	})

	it("GB regression — byte-identical to the pre-4b quarter-mirror output", () => {
		const formatted = formatAddress(
			{
				house_number: "2",
				street: "High Street",
				dependent_locality: "Plaistow",
				locality: "Bromley",
				postcode: "BR1 4AA",
			},
			"GB"
		)

		expect(formatted).toBe("2 High Street\nPlaistow\nBromley\nBR1 4AA")
	})

	it("NZ regression — byte-identical to the pre-4b suburb-mapping output", () => {
		const formatted = formatAddress(
			{
				house_number: "12",
				street: "Queen Street",
				dependent_locality: "Ponsonby",
				locality: "Auckland",
				postcode: "1011",
			},
			"NZ"
		)

		expect(formatted).toBe("12 Queen Street\nPonsonby\nAuckland 1011")
	})

	it("BR regression — byte-identical; both-slots template must not double-render or gain a place mirror", () => {
		const formatted = formatAddress(
			{
				house_number: "45",
				street: "Rua das Flores",
				dependent_locality: "Vila Mariana",
				locality: "São Paulo",
				region: "SP",
				postcode: "04101-000",
			},
			"BR"
		)

		expect(formatted).toBe("Rua das Flores, 45\nVila Mariana\nSão Paulo - SP\n04101-000")
	})

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

describe("injectDependentLocalityLine", () => {
	it("splices the value as its own line directly above the locality's line", () => {
		const result = injectDependentLocalityLine("Carretera A-2522, 35\n01450 Amurrio", "Amurrio", "Baranbio")
		expect(result).toBe("Carretera A-2522, 35\nBaranbio\n01450 Amurrio")
	})

	it("is idempotent — running it again on its own output does not duplicate the line", () => {
		const once = injectDependentLocalityLine("Carretera A-2522, 35\n01450 Amurrio", "Amurrio", "Baranbio")
		const twice = injectDependentLocalityLine(once, "Amurrio", "Baranbio")
		expect(twice).toBe(once)
		expect(twice.match(/Baranbio/g)).toHaveLength(1)
	})

	it("does not misfire on an incidental substring collision (dependent_locality embedded inside the locality string)", () => {
		// Regression for the exact false-positive the ES pedanía report flagged: the alignment gate's naive
		// whole-string `includes` check saw "Cea" as already present because it's a trailing substring of the
		// locality "San Cristovo de Cea" — but the template never actually rendered a distinct suburb line. This
		// helper anchors on the LOCALITY's line, not a whole-string substring test, so it still splices "Cea" in
		// as its own real line.
		const result = injectDependentLocalityLine(
			"Calle Jose Antonio, 82\n32130 San Cristovo de Cea",
			"San Cristovo de Cea",
			"Cea"
		)

		expect(result).toBe("Calle Jose Antonio, 82\nCea\n32130 San Cristovo de Cea")
	})

	it("returns raw unchanged when locality is missing (no safe anchor)", () => {
		const raw = "Carretera A-2522, 35\n01450"
		expect(injectDependentLocalityLine(raw, undefined, "Baranbio")).toBe(raw)
	})

	it("returns raw unchanged when locality never appears in raw (no safe anchor)", () => {
		const raw = "Carretera A-2522, 35\n01450 Amurrio"
		expect(injectDependentLocalityLine(raw, "Bilbao", "Baranbio")).toBe(raw)
	})

	it("anchors on the LAST matching line, not the first (a street named after its own municipio)", () => {
		// "Avenida de Amurrio" is a street literally named after the town — its line also contains the
		// locality substring. A first-match anchor would splice the dependent-locality line above the
		// STREET; it belongs above the actual locality/postcode line further down.
		const result = injectDependentLocalityLine("Avenida de Amurrio, 12\n01450 Amurrio", "Amurrio", "Baranbio")
		expect(result).toBe("Avenida de Amurrio, 12\nBaranbio\n01450 Amurrio")
	})
})

describe("formatFromClassificationMap", () => {
	it("bridges the legacy rule-classifier vocabulary through the same formatter", () => {
		const map: ClassificationMap = new Map([
			["house_number", ["123"]],
			["street", ["Main St"]],
			["locality", ["Portland"]],
			["region", ["OR"]],
			["postcode", ["97201"]],
		])

		const formatted = formatFromClassificationMap(map, "US", { separator: ", " })

		for (const token of ["123", "Main", "Portland", "97201"]) {
			expect(formatted).toContain(token)
		}
	})

	it("merges unit and level labels onto the road line", () => {
		const map: ClassificationMap = new Map([
			["house_number", ["1"]],
			["street", ["Elm"]],
			["unit", ["Apt 4"]],
			["level", ["Floor 2"]],
			["locality", ["Ames"]],
		])

		const formatted = formatFromClassificationMap(map, "US", { separator: ", " })
		expect(formatted).toContain("Apt 4")
		expect(formatted).toContain("Floor 2")
	})
})

describe("reconcileComponents", () => {
	it("keeps only components whose value survives into the formatted string", () => {
		const components: ComponentDict = { locality: "Paris", region: "Île-de-France", postcode: "75008" }
		const raw = "75008 Paris"

		expect(reconcileComponents(components, raw)).toEqual({ locality: "Paris", postcode: "75008" })
	})

	it("is case- and whitespace-insensitive", () => {
		expect(reconcileComponents({ locality: "San  Francisco" }, "san francisco ca")).toEqual({
			locality: "San  Francisco",
		})
	})
})
