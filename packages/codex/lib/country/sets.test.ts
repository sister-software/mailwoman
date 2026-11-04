// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { CountryISO2 } from "#country/codes"
import { OFFICIAL_LANGUAGES } from "#country/official-languages"
import { COUNTRY_REFERENCE } from "#country/reference/data"
import {
	countriesDeclaredBy,
	countriesOfAddressSystem,
	countriesOfScript,
	countriesOfWeightsFamily,
	type CountrySet,
	dependentTerritories,
	hasCountry,
	intersect,
	minus,
	union,
	worldCountries,
} from "#country/sets"
import { COUNTRY_SCRIPTS, SCRIPT_CODES } from "#country/writing-systems"

/**
 * Stands in for a signature that states the set it needs.
 */
function takesWorld(countries: CountrySet<{ world: true }>): number {
	return countries.size
}

describe("worldCountries", () => {
	it("holds every CountryISO2 value", () => {
		expect([...worldCountries()].toSorted()).toEqual(Object.values(CountryISO2).toSorted())
	})

	it("refuses a literal array or an unbranded set at compile time", () => {
		expect(takesWorld(worldCountries())).toBe(Object.values(CountryISO2).length)

		// @ts-expect-error A literal array is not a CountrySet.
		expect(() => takesWorld(["US", "FR"])).not.toThrow()

		// @ts-expect-error A plain Set carries no brand.
		expect(takesWorld(new Set(["US", "FR"]))).toBe(2)

		// @ts-expect-error A set from another source does not satisfy a world-set parameter.
		expect(takesWorld(countriesOfScript("Latn"))).toBeGreaterThan(0)
	})
})

describe("countriesOfScript", () => {
	it("places a country in every script its official languages are written in", () => {
		for (const script of ["Latn", "Cyrl"] as const) {
			expect(hasCountry(countriesOfScript(script), "RS")).toBe(true)
		}

		for (const script of ["Hani", "Hira", "Kana"] as const) {
			expect(hasCountry(countriesOfScript(script), "JP")).toBe(true)
		}

		for (const script of ["Hani", "Latn"] as const) {
			expect(hasCountry(countriesOfScript(script), "HK")).toBe(true)
			expect(hasCountry(countriesOfScript(script), "MO")).toBe(true)
		}
	})

	it("agrees with COUNTRY_SCRIPTS for every ISO country and script", () => {
		for (const script of SCRIPT_CODES) {
			const members = countriesOfScript(script)

			for (const code of Object.values(CountryISO2)) {
				expect(members.has(code)).toBe(COUNTRY_SCRIPTS[code]?.includes(script) ?? false)
			}
		}
	})

	it("covers every territory OFFICIAL_LANGUAGES gives an official language", () => {
		const withOfficial = Object.entries(OFFICIAL_LANGUAGES)
			.filter(([, entry]) => entry.official.length)
			.map(([code]) => code)

		expect(Object.keys(COUNTRY_SCRIPTS).toSorted()).toEqual(withOfficial.toSorted())
	})
})

describe("dependentTerritories", () => {
	it("reads the dependency column, and the sovereign states are the rest of the world", () => {
		const marked = Object.keys(COUNTRY_REFERENCE).filter(
			(code) => COUNTRY_REFERENCE[code]!.dependency && hasCountry(worldCountries(), code)
		)

		expect([...dependentTerritories()].toSorted()).toEqual(marked.toSorted())

		const sovereign = minus(worldCountries(), dependentTerritories())

		expect(sovereign.size + dependentTerritories().size).toBe(worldCountries().size)
		expect(hasCountry(sovereign, "FR")).toBe(true)
		expect(hasCountry(sovereign, "PR")).toBe(false)
	})
})

describe("countriesOfAddressSystem", () => {
	const table = { members: { "US/local": 3, "CA/local": 3, "PR/latin": 3, "FR/local": 1, "XX/local": 3 } }

	it("collects every ISO country whose member shares the system country's id", () => {
		expect([...countriesOfAddressSystem("us", table)].toSorted()).toEqual(["CA", "PR", "US"])
	})

	it("refuses a table without the system country's local member", () => {
		expect(() => countriesOfAddressSystem("jp", table)).toThrow(/JP\/local/)
	})
})

describe("countriesOfWeightsFamily", () => {
	it("joins locale regions and languages through OFFICIAL_LANGUAGES", () => {
		const cjk = countriesOfWeightsFamily({ family: "cjk", locales: ["cjk", "ja-jp", "zh-cn"], languages: ["ko"] })

		for (const code of ["JP", "CN", "TW", "HK", "MO", "SG", "KR", "KP"]) {
			expect(hasCountry(cjk, code)).toBe(true)
		}

		expect(hasCountry(cjk, "US")).toBe(false)
	})
})

describe("countriesDeclaredBy", () => {
	it("keeps the declaration's order and refuses a non-ISO code", () => {
		expect([...countriesDeclaredBy("test", ["NL", "DE"])]).toEqual(["NL", "DE"])
		expect(() => countriesDeclaredBy("test", ["NL", "QQ", "ZZ"])).toThrow(/test lists .*QQ, ZZ/)
	})
})

describe("set operations", () => {
	it("keep the brand and combine members", () => {
		const latin = countriesOfScript("Latn")
		const cyrillic = countriesOfScript("Cyrl")
		const both = intersect(latin, cyrillic)

		expect(hasCountry(both, "RS")).toBe(true)
		expect(hasCountry(both, "FR")).toBe(false)
		expect(union(latin, cyrillic).size).toBe(latin.size + cyrillic.size - both.size)
		expect(hasCountry(minus(cyrillic, latin), "RU")).toBe(true)

		// @ts-expect-error A union's spec records the operation, so it is not a world set.
		takesWorld(union(latin, cyrillic))
	})
})
