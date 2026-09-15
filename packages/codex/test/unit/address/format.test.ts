/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The formatter's public surface, over the layout table this package now owns.
 *
 *   Most of what this file used to assert was about the third-party engine's vocabulary — whether a country's mustache
 *   template names `suburb` or `quarter` or neither, whether a connector survived an empty slot, whether a missing line
 *   could be spliced back in afterwards. None of those questions exist once the order is data: a layout that declares a
 *   `dependent_locality` slot has one, and a line assembled from present values writes no connector around an absent
 *   one. What survives here is the BEHAVIOUR those mechanisms were reaching for, asserted on output.
 */

import {
	componentsPresentIn,
	formatAddress,
	formatAddressRow,
	type ComponentDict,
} from "@mailwoman/codex/address-format"
import { describe, expect, it } from "vitest"

const US_ADDRESS: ComponentDict = {
	house_number: "123",
	street: "Main St",
	locality: "Portland",
	region: "OR",
	postcode: "97201",
}

describe("formatAddress", () => {
	it("renders a canonical US address as an envelope by default", () => {
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

	it("collapses to a single line when a separator is given", () => {
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

	it("joins single-line output the way the COUNTRY does, not the way English does", () => {
		const tokyo: ComponentDict = {
			region: "東京都",
			subregion: "千代田区",
			dependent_locality: "丸の内",
			house_number: "1-9-1",
			postcode: "100-0005",
		}

		// A comma join here would print the romanized convention backwards.
		expect(formatAddress(tokyo, "JP", { singleLine: true })).toBe("〒100-0005 東京都千代田区丸の内1-9-1")
		expect(formatAddress(US_ADDRESS, "US", { singleLine: true })).toBe("123 Main St, Portland, OR 97201")
	})

	it("returns an empty string for an empty dict", () => {
		expect(formatAddress({}, "US")).toBe("")
	})

	it("returns an empty string for a country the dataset gives no order", () => {
		// Absence is a real answer: 55 of the 252 shipped country records carry no usable skeleton.
		expect(formatAddress(US_ADDRESS, "ZZ")).toBe("")
	})

	it("writes no connector around an absent value", () => {
		const noRegion = formatAddress({ locality: "New York", postcode: "10118" }, "US", { separator: ", " })
		const noPostcode = formatAddress({ locality: "New York", region: "NY" }, "US", { separator: ", " })
		const both = formatAddress({ locality: "New York", region: "NY", postcode: "10118" }, "US", { separator: ", " })

		expect(noRegion).toBe("New York, 10118")
		expect(noPostcode).toBe("New York, NY")
		expect(both).toBe("New York, NY 10118")
	})

	it("drops a connector standing at a line's edge with its own slot", () => {
		// Japan's postal mark binds to the postcode it precedes, so it goes when the postcode does.
		const withPostcode = formatAddress({ postcode: "100-0005", region: "東京都" }, "JP", { singleLine: true })
		const without = formatAddress({ region: "東京都" }, "JP", { singleLine: true })

		expect(withPostcode).toBe("〒100-0005 東京都")
		expect(without).toBe("東京都")
	})

	it("renders the dependent locality where the country prints it", () => {
		const gb = formatAddress(
			{
				house_number: "2",
				street: "High Street",
				dependent_locality: "Plaistow",
				locality: "Bromley",
				postcode: "BR1 4AA",
			},
			"GB"
		)

		expect(gb).toBe("2 High Street\nPlaistow\nBromley\nBR1 4AA")

		const nz = formatAddress(
			{
				house_number: "12",
				street: "Queen Street",
				dependent_locality: "Ponsonby",
				locality: "Auckland",
				postcode: "1011",
			},
			"NZ"
		)

		expect(nz).toBe("12 Queen Street\nPonsonby\nAuckland 1011")

		// La Poste's line 5 is the lieu-dit, directly above the postcode+town line.
		const fr = formatAddress(
			{
				house_number: "12",
				street: "Rue de la Paix",
				dependent_locality: "Les Chênes",
				locality: "Saint-Julien",
				postcode: "38000",
			},
			"FR"
		)

		expect(fr).toBe("12 Rue de la Paix\nLes Chênes\n38000 Saint-Julien")
	})

	it("renders a canonical FR address with FR ordering", () => {
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

	it("renders an intersection instead of a street name, not beside it", () => {
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

	it("appends the unit to the street line", () => {
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

	it("gives a post-office box its own line above the street, and prints both", () => {
		const boxAndStreet = formatAddress(
			{
				po_box: "P.O. Box 5",
				house_number: "100",
				street: "Main St",
				locality: "Portland",
				region: "OR",
				postcode: "97214",
			},
			"US",
			{ separator: ", " }
		)

		expect(boxAndStreet).toBe("P.O. Box 5, 100 Main St, Portland, OR 97214")

		const boxOnly = formatAddress({ po_box: "P.O. Box 5", locality: "Portland", region: "OR" }, "US", {
			separator: ", ",
		})

		expect(boxOnly).toBe("P.O. Box 5, Portland, OR")
	})
})

describe("formatAddressRow", () => {
	it("answers the render and the tags it printed, in one pass", () => {
		const row = formatAddressRow(US_ADDRESS, "US", { singleLine: true })

		expect(row?.raw).toBe("123 Main St, Portland, OR 97201")
		expect(row?.components).toEqual(US_ADDRESS)
		expect(row?.unplaced).toEqual([])
	})

	it("NAMES a value the layout has no slot for rather than dropping it silently", () => {
		// France absorbs the region: its skeleton has no %S, so the value is carried nowhere.
		const row = formatAddressRow({ locality: "Paris", region: "Île-de-France", postcode: "75008" }, "FR", {
			singleLine: true,
		})

		expect(row?.raw).toBe("75008 Paris")
		expect(row?.components).toEqual({ locality: "Paris", postcode: "75008" })
		expect(row?.unplaced).toEqual(["region"])
	})

	it("reads the alignment rather than inferring it from the string", () => {
		// A substring test answers `street` here because `Paris` sits inside `Rue de Paris`. The render knows the
		// layout placed both, so it does not have to guess.
		const components: ComponentDict = {
			house_number: "5",
			street: "Rue de Paris",
			locality: "Paris",
			postcode: "75008",
		}

		const row = formatAddressRow(components, "FR", { singleLine: true })

		expect(row?.raw).toBe("5 Rue de Paris, 75008 Paris")
		expect(row?.components).toEqual(components)
	})

	it("answers null when nothing rendered", () => {
		expect(formatAddressRow({}, "US")).toBeNull()
		expect(formatAddressRow(US_ADDRESS, "ZZ")).toBeNull()
	})
})

describe("the script a row renders in", () => {
	/**
	 * The same Hong Kong address in both registers. Rendering either through one country-keyed layout prints one of them
	 * in an order nobody writes, which is the whole reason the selection exists.
	 */
	const HK_LATIN: ComponentDict = {
		street: "Jordan Road",
		house_number: "21",
		dependent_locality: "Jordan",
		locality: "Kowloon",
	}

	const HK_LOCAL: ComponentDict = {
		street: "佐敦道",
		house_number: "21號",
		dependent_locality: "佐敦",
		locality: "九龍",
	}

	it("reads the register off the components, and says which it chose", () => {
		expect(formatAddressRow(HK_LATIN, "HK", { singleLine: true })).toMatchObject({
			script: "latin",
			raw: "21 Jordan Road, Jordan, Kowloon",
		})

		expect(formatAddressRow(HK_LOCAL, "HK", { singleLine: true })?.script).toBe("local")
	})

	it("carries the separator the chosen order takes, not the country's", () => {
		// The defect this closes: the order came from the layout and the separator from a country flag, so a Latin
		// Hong Kong address could print in Latin order with the unseparated Chinese join.
		expect(formatAddress(HK_LATIN, "HK", { singleLine: true })).toContain(", ")
		expect(formatAddress(HK_LOCAL, "HK", { singleLine: true })).not.toContain(", ")
	})

	it("flips Korea to the romanized order on romanized values", () => {
		const latin = formatAddress(
			{ region: "Seoul", locality: "Jongno-gu", dependent_locality: "Cheongun-dong", house_number: "52-1" },
			"KR",
			{ singleLine: true }
		)

		const local = formatAddress(
			{ region: "서울특별시", locality: "종로구", dependent_locality: "청운동", house_number: "52-1" },
			"KR",
			{ singleLine: true }
		)

		expect(latin).toBe("52-1, Cheongun-dong, Jongno-gu, Seoul")
		expect(local).toBe("서울특별시 종로구청운동 52-1")
	})

	it("lets the caller override what the values say", () => {
		// A caller holding a parse tree knows more than the values do: every span carries the script it is written in.
		expect(formatAddressRow(HK_LATIN, "HK", { singleLine: true, script: "local" })?.script).toBe("local")
		expect(formatAddressRow(HK_LOCAL, "HK", { singleLine: true, script: "latin" })?.script).toBe("latin")
	})

	it("holds Japan at its own order, because the Latin one would drop two components", () => {
		const romanized: ComponentDict = {
			region: "Tokyo",
			locality: "Chiyoda",
			dependent_locality: "Marunouchi",
			house_number: "1-9-1",
			postcode: "100-0005",
		}

		// Seven of the eight two-order countries place slot for slot. Japan's Latin skeleton has no slot below the
		// prefecture, so deriving there would trade an order nobody writes for `locality` and `dependent_locality`.
		const derived = formatAddressRow(romanized, "JP", { singleLine: true })

		expect(derived?.script).toBe("local")
		expect(derived?.unplaced).toEqual([])

		// The caller can still ask for it, and then the loss is theirs to see — it is reported, not silent.
		expect(formatAddressRow(romanized, "JP", { singleLine: true, script: "latin" })?.unplaced).toEqual([
			"locality",
			"dependent_locality",
		])
	})

	it("abstains on a dict with no letters rather than reading digits as Latin", () => {
		// The meaning-of-zero rule: no letters is not evidence of a register, so the country's own default stands.
		const digits = formatAddressRow({ house_number: "21", postcode: "100-0005" }, "JP", { singleLine: true })

		expect(digits?.script).toBe("local")
	})

	it("leaves a one-order country reading through to its only layout", () => {
		expect(formatAddressRow(US_ADDRESS, "US", { singleLine: true })).toMatchObject({
			script: "latin",
			raw: "123 Main St, Portland, OR 97201",
		})
	})
})

describe("componentsPresentIn", () => {
	it("keeps only the components whose value occurs in the string", () => {
		const components: ComponentDict = { locality: "Paris", region: "Île-de-France", postcode: "75008" }

		expect(componentsPresentIn(components, "75008 Paris")).toEqual({ locality: "Paris", postcode: "75008" })
	})

	it("is case- and whitespace-insensitive", () => {
		expect(componentsPresentIn({ locality: "San  Francisco" }, "san francisco ca")).toEqual({
			locality: "San  Francisco",
		})
	})
})
