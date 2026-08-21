/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The surfaces this module exists to supply are the ones that failed a live 35-address bare-toponym probe on
 *   2026-08-15: every non-Latin country query returned nothing, and every one of them was a gazetteer miss rather than
 *   a tagging miss. These cases pin the specific strings, not just the mechanism.
 */

import { countryDisplayNames, enumerateCountryDisplayNames } from "@mailwoman/codex/country/display-names"
import { describe, expect, it } from "vitest"

describe("enumerateCountryDisplayNames", () => {
	it("supplies the exact surfaces the bare-toponym probe could not resolve", () => {
		// Left column is what a user typed and got nothing for; right is the country it means.
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
		// The probe's sharpest case: 佐治亚州 (the US state) resolved and 格鲁吉亚 (the country) did not, while the
		// model gave BOTH the same wrong `locality` tag. Only the country belongs to this table.
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

	it("emits no row for a code ICU does not recognise", () => {
		// `Intl.DisplayNames.of` echoes an unknown code, and the echo is the miss signal.
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

		// Measured 280 regions / 5,244 surfaces at time of writing. Floors, not equalities — an ICU upgrade may add
		// names, and pinning exact counts would fail on a Node bump for no reason.
		expect(countries.size).toBeGreaterThanOrEqual(240)
		expect(rows.length).toBeGreaterThanOrEqual(3000)
	})
})
