/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { countrySurfaceForms, isCountryToken, matchCountry } from "./country.js"

test("matchCountry: resolves alpha-2, alpha-3, and name (case-insensitive) to the iso2", () => {
	expect(matchCountry("US")?.iso2).toBe("US")
	expect(matchCountry("usa")?.iso2).toBe("US") // alpha-3, lower-case
	expect(matchCountry("DE")?.iso2).toBe("DE")
	expect(matchCountry("DEU")?.iso2).toBe("DE") // alpha-3
	expect(matchCountry("  gb ")?.iso2).toBe("GB") // trimmed
})

test("matchCountry: returns the canonical name + the matched surface; null when unknown", () => {
	const m = matchCountry("US")
	expect(m).not.toBeNull()
	expect(typeof m!.canonical).toBe("string")
	expect(m!.canonical!.length).toBeGreaterThan(0)
	expect(matchCountry("  US ")?.matched).toBe("US") // matched is the trimmed surface

	expect(matchCountry("Narnia")).toBeNull()
	expect(matchCountry("")).toBeNull()
	expect(matchCountry(null)).toBeNull()
	expect(matchCountry(undefined)).toBeNull()
})

test("countrySurfaceForms: curated forms round-trip back through matchCountry", () => {
	const forms = countrySurfaceForms("US")
	expect(forms.length).toBeGreaterThan(0)

	for (const form of forms) {
		expect(matchCountry(form)?.iso2).toBe("US")
	}
	// unknown / uncurated iso2 → empty
	expect(countrySurfaceForms("ZZ")).toEqual([])
})

test("isCountryToken: true for any recognized form, false otherwise", () => {
	for (const tok of ["US", "usa", "DE", "deu", "GB"]) {
		expect(isCountryToken(tok)).toBe(true)
	}

	for (const tok of ["Narnia", "", 7, null, undefined]) {
		expect(isCountryToken(tok)).toBe(false)
	}
})
