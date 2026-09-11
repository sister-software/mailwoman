/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One real address per locale this project publishes weights for, with the surface it must render to.
 *
 *   This board exists because the engine it replaces got five of these eleven wrong, and nothing measured it. The
 *   OpenCage templates are written for OpenStreetMap's tag vocabulary and are correct for the anglophone and
 *   German-order locales; they insert a comma into Spain's street line, drop Italy's province, reorder India's tail,
 *   and print BOTH CJK locales backwards with commas inserted — `1-9-1, 丸の内, 千代田区, 東京都 100-0005` where the
 *   convention is `〒100-0005 東京都千代田区丸の内1-9-1`.
 *
 *   Provenance for the CJK rows is this repository's own: `corpus/lib/jp/adapters/wof-admin` declares the Japanese
 *   envelope as `〒<postcode>? <region><locality><neighbourhood>?`, `mailwoman/test/unit/geocode/routed-classifier`
 *   carries `〒930-0393 富山県中新川郡上市町法音寺1` as a real parse fixture, and `corpus/lib/cn/recipes/
 *   organizational-units` decomposes `云南省临沧市孟定农场三分场二队` largest-first with no separators. The Latin rows
 *   are the libaddressinput skeletons.
 */

import { ADDRESS_LAYOUTS, LINE_JOINS } from "@mailwoman/codex/address-layouts"
import { joinRendering, renderAddress, type ComponentDict } from "@mailwoman/codex/address-render"
import { describe, expect, it } from "vitest"

interface BoardRow {
	readonly country: string
	readonly components: ComponentDict
	readonly expected: string
}

const BOARD: readonly BoardRow[] = [
	{
		country: "US",
		components: {
			house_number: "350",
			street: "Fifth Avenue",
			locality: "New York",
			region: "NY",
			postcode: "10118",
		},
		expected: "350 Fifth Avenue, New York, NY 10118",
	},
	{
		country: "FR",
		components: {
			house_number: "55",
			street: "Rue du Faubourg Saint-Honoré",
			locality: "Paris",
			postcode: "75008",
		},
		expected: "55 Rue du Faubourg Saint-Honoré, 75008 Paris",
	},
	{
		country: "GB",
		components: { house_number: "64", street: "Middlesex Street", locality: "London", postcode: "E1 7EZ" },
		expected: "64 Middlesex Street, London, E1 7EZ",
	},
	{
		country: "DE",
		components: { house_number: "1", street: "Pariser Platz", locality: "Berlin", postcode: "10117" },
		expected: "Pariser Platz 1, 10117 Berlin",
	},
	{
		country: "ES",
		components: { house_number: "3", street: "Calle de Alcalá", locality: "Madrid", postcode: "28014" },
		// Spain separates the street name from the number with a comma.
		expected: "Calle de Alcalá, 3, 28014 Madrid",
	},
	{
		country: "IT",
		components: { house_number: "10", street: "Via del Corso", locality: "Roma", region: "RM", postcode: "00186" },
		expected: "Via del Corso 10, 00186 Roma RM",
	},
	{
		country: "IN",
		components: {
			house_number: "12",
			street: "Barakhamba Road",
			locality: "New Delhi",
			region: "Delhi",
			postcode: "110001",
		},
		// India writes the number, then a comma, then the street.
		expected: "12, Barakhamba Road, New Delhi 110001, Delhi",
	},
	{
		country: "NZ",
		components: {
			house_number: "31",
			street: "Rawene Road",
			dependent_locality: "Birkenhead",
			locality: "Auckland",
			postcode: "0626",
		},
		expected: "31 Rawene Road, Birkenhead, Auckland 0626",
	},
	{
		country: "AU",
		components: {
			house_number: "1",
			street: "Macquarie Street",
			locality: "Sydney",
			region: "NSW",
			postcode: "2000",
		},
		expected: "1 Macquarie Street, Sydney NSW 2000",
	},
	{
		country: "JP",
		components: {
			postcode: "100-0005",
			region: "東京都",
			locality: "千代田区",
			dependent_locality: "丸の内",
			house_number: "1-9-1",
		},
		expected: "〒100-0005 東京都千代田区丸の内1-9-1",
	},
	{
		country: "JP",
		components: {
			postcode: "930-0393",
			region: "富山県",
			subregion: "中新川郡",
			locality: "上市町",
			dependent_locality: "法音寺",
			house_number: "1",
		},
		expected: "〒930-0393 富山県中新川郡上市町法音寺1",
	},
	{
		country: "CN",
		components: { region: "上海市", locality: "黄浦区", street: "南京东路", house_number: "300号" },
		expected: "上海市黄浦区南京东路300号",
	},
]

const render = (country: string, components: ComponentDict): string =>
	joinRendering(renderAddress(ADDRESS_LAYOUTS[country]!, components), LINE_JOINS[country] ?? ", ")

describe("the eleven shipped locales", () => {
	for (const row of BOARD) {
		it(`${row.country} renders ${row.expected}`, () => {
			expect(render(row.country, row.components)).toBe(row.expected)
		})
	}
})

describe("a partly-filled address drops what it cannot print, and its connectors with it", () => {
	const base: ComponentDict = { house_number: "350", street: "Fifth Avenue" }

	it("prints the whole tail when every part is present", () => {
		expect(render("US", { ...base, locality: "New York", region: "NY", postcode: "10118" })).toBe(
			"350 Fifth Avenue, New York, NY 10118"
		)
	})

	it("drops a trailing postcode without leaving its space", () => {
		expect(render("US", { ...base, locality: "New York", region: "NY" })).toBe("350 Fifth Avenue, New York, NY")
	})

	it("drops a trailing region and postcode without leaving the comma", () => {
		expect(render("US", { ...base, locality: "New York" })).toBe("350 Fifth Avenue, New York")
	})

	it("keeps the stronger separator when the middle of a line is missing", () => {
		// Adjacent survivors collapse to the FIRST, which is the behaviour the engine this replaces produced.
		expect(render("US", { ...base, locality: "New York", postcode: "10118" })).toBe("350 Fifth Avenue, New York, 10118")
	})

	it("drops a leading locality without leaving the comma", () => {
		expect(render("US", { ...base, region: "NY", postcode: "10118" })).toBe("350 Fifth Avenue, NY 10118")
	})

	it("renders nothing for an empty dict", () => {
		expect(render("US", {})).toBe("")
	})
})

describe("the street line", () => {
	it("prints an intersection instead of a street", () => {
		expect(
			render("US", {
				intersection_a: "Market St",
				intersection_b: "Castro St",
				locality: "San Francisco",
				region: "CA",
			})
		).toBe("Market St & Castro St, San Francisco, CA")
	})

	it("assembles a split street family in its declared order", () => {
		expect(
			render("US", {
				house_number: "1600",
				street_prefix: "N",
				street: "Wells",
				street_suffix: "St",
				locality: "Chicago",
				region: "IL",
				postcode: "60614",
			})
		).toBe("1600 N Wells St, Chicago, IL 60614")
	})

	it("carries a unit on the street line, where the tag vocabulary has no slot of its own", () => {
		expect(
			render("US", {
				house_number: "600",
				street: "Pennsylvania Ave NW",
				unit: "Apt 4B",
				locality: "Washington",
				region: "DC",
				postcode: "20500",
			})
		).toBe("600 Pennsylvania Ave NW Apt 4B, Washington, DC 20500")
	})

	it("leads with the venue for a US envelope, the way a geocoder user types it", () => {
		expect(
			render("US", {
				venue: "Iowa Masonry Inc",
				house_number: "4501",
				street: "NW 2nd St",
				locality: "Des Moines",
				region: "IA",
				postcode: "50313",
			})
		).toBe("Iowa Masonry Inc, 4501 NW 2nd St, Des Moines, IA 50313")
	})
})

describe("the postal mark binds to the postcode", () => {
	it("prints 〒 with a postcode", () => {
		expect(render("JP", { postcode: "100-0005", region: "東京都", locality: "千代田区" })).toBe(
			"〒100-0005 東京都千代田区"
		)
	})

	it("drops 〒 with no postcode, rather than printing a bare mark", () => {
		expect(render("JP", { region: "東京都", locality: "千代田区", dependent_locality: "丸の内" })).toBe(
			"東京都千代田区丸の内"
		)
	})
})

describe("a rendering says what it placed and what it could not", () => {
	it("names a component the layout has no slot for, rather than dropping it silently", () => {
		const rendering = renderAddress(ADDRESS_LAYOUTS["FR"]!, {
			house_number: "55",
			street: "Rue du Faubourg Saint-Honoré",
			locality: "Paris",
			postcode: "75008",
			region: "Île-de-France",
		})

		expect(rendering.placed).toContain("locality")
		// France's layout prints no region: the postcode line absorbs it. That is a fact the render holds, where a
		// substring search over the output could not tell it from a value that never arrived.
		expect(rendering.unplaced).toEqual(["region"])
	})

	it("reports every tag it printed", () => {
		const rendering = renderAddress(ADDRESS_LAYOUTS["US"]!, {
			house_number: "350",
			street: "Fifth Avenue",
			locality: "New York",
			region: "NY",
			postcode: "10118",
		})

		expect(rendering.placed.toSorted()).toEqual(["house_number", "locality", "postcode", "region", "street"])
		expect(rendering.unplaced).toEqual([])
	})
})
