/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The non-Latin country surfaces this module exists to supply. These cases pin the specific strings rather than
 *   just the mechanism.
 */

import { describe, expect, it } from "vitest"

import { countryDisplayNames, enumerateCountryDisplayNames } from "#country"

describe("enumerateCountryDisplayNames", () => {
	it("supplies the exact surfaces the bare-toponym probe could not resolve", () => {
		// Left is the surface a user typed.
		// Right is the country it means.
		const wanted: Array<[string, string]> = [
			["格鲁吉亚", "GE"],
			["沙特阿拉伯", "SA"],
			["沙烏地阿拉伯", "SA"],
			["巴布亚新几内亚", "PG"],
			["巴布亞紐幾內亞", "PG"],
			["多米尼加共和国", "DO"],
			["多明尼加共和國", "DO"],
			["布基纳法索", "BF"],
			["英国", "GB"],
			["英國", "GB"],
		]

		for (const [surface, iso2] of wanted) {
			expect(countryDisplayNames(iso2), `${surface} → ${iso2}`).toContain(surface)
		}
	})

	it("keeps Georgia-the-country and Georgia-the-state distinguishable", () => {
		// 佐治亚州 is the US state and 格鲁吉亚 the country.
		// Only the country belongs to this table.
		const ge = countryDisplayNames("GE")

		expect(ge).toContain("格鲁吉亚")
		expect(ge).not.toContain("佐治亚州")
	})

	it("carries short forms, which is the register people actually type", () => {
		expect(countryDisplayNames("GB")).toContain("UK")
	})

	it("attributes each surface to the locale that produced it", () => {
		const rows = [...enumerateCountryDisplayNames(["zh-Hans"])]
		const georgia = rows.find((r) => r.iso2 === "GE")

		expect(georgia?.locale).toBe("zh-Hans")
		expect(georgia?.name).toBe("格鲁吉亚")
	})

	it("emits no row for a code ICU does not recognize", () => {
		// `Intl.DisplayNames.of` echoes an unknown code.
		// The echo signals a miss.
		expect([...enumerateCountryDisplayNames()].some((r) => r.iso2 === "ZZ" && r.name === "ZZ")).toBe(false)
	})

	it("deduplicates a surface reached from several locales", () => {
		const rows = [...enumerateCountryDisplayNames()].filter((r) => r.iso2 === "PG")
		const names = rows.map((r) => r.name)

		expect(names).toHaveLength(new Set(names).size)
	})

	it("covers the ISO region set broadly enough to be worth shipping", () => {
		const rows = [...enumerateCountryDisplayNames()]
		const countries = new Set(rows.map((r) => r.iso2))

		// These assertions check floors rather than equalities.
		// An ICU upgrade may add names.
		// Exact counts would fail after a Node bump.
		expect(countries.size).toBeGreaterThanOrEqual(240)
		expect(rows.length).toBeGreaterThanOrEqual(3000)
	})
})
