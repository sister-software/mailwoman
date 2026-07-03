/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CLDR-derived official-language table (#936 ingest bit). The cases pin the classifications
 *   the risk probe's verdict depends on: bilingual FI (the Åbo row), de-facto English in the US,
 *   and the regional tier staying opt-in (Catalan in ES; Korean-in-CN was the probe's cautionary
 *   example).
 */

import { expect, test } from "vitest"

import { isOfficialLanguage, OFFICIAL_LANGUAGES } from "./official-languages.js"

test("bilingual Finland: Swedish is official under both ISO spellings", () => {
	expect(isOfficialLanguage("FI", "sv")).toBe(true)
	expect(isOfficialLanguage("FI", "swe")).toBe(true)
	expect(isOfficialLanguage("FI", "fin")).toBe(true)
})

test("de-facto official counts as official (English in the US)", () => {
	expect(isOfficialLanguage("US", "eng")).toBe(true)
})

test("regional-official is opt-in (Catalan in ES)", () => {
	expect(isOfficialLanguage("ES", "cat")).toBe(false)
	expect(isOfficialLanguage("ES", "cat", true)).toBe(true)
})

test("non-official languages and unknown territories are false", () => {
	expect(isOfficialLanguage("FI", "el")).toBe(false)
	expect(isOfficialLanguage("XX", "en")).toBe(false)
})

test("case-insensitive on both axes", () => {
	expect(isOfficialLanguage("fi", "SV")).toBe(true)
})

test("the table carries a plausible territory count", () => {
	expect(Object.keys(OFFICIAL_LANGUAGES).length).toBeGreaterThan(200)
})
