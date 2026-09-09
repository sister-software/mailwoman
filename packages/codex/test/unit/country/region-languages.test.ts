/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { officialLanguagesAlpha3, regionLanguagesAlpha3 } from "@mailwoman/codex/country"
import { coOfficialLanguagesForProvince, ES_PROVINCE_CO_OFFICIAL_LANGUAGES } from "@mailwoman/codex/es"
import { describe, expect, it } from "vitest"

describe("officialLanguagesAlpha3", () => {
	it("answers the three-letter spellings only, and nothing for an unknown country", () => {
		expect(officialLanguagesAlpha3("ES")).toEqual(["spa"])
		expect(officialLanguagesAlpha3("gb")).toContain("eng")
		expect(officialLanguagesAlpha3("XX")).toEqual([])
	})
})

describe("regionLanguagesAlpha3", () => {
	it("adds a Spanish province's co-official languages after Castilian", () => {
		expect(regionLanguagesAlpha3("ES", "Islas Baleares")).toEqual(["spa", "cat"])
		expect(regionLanguagesAlpha3("ES", "Lleida")).toEqual(["spa", "cat", "oci"])
		expect(regionLanguagesAlpha3("ES", "La Coruña")).toEqual(["spa", "glg"])
		expect(regionLanguagesAlpha3("ES", "Vizcaya")).toEqual(["spa", "eus"])
	})

	it("answers Castilian alone for a province with no co-official language, and the official set elsewhere", () => {
		expect(regionLanguagesAlpha3("ES", "Zamora")).toEqual(["spa"])
		expect(regionLanguagesAlpha3("ES", "Asturias")).toEqual(["spa"])
		expect(regionLanguagesAlpha3("GB", "Highland")).toEqual(officialLanguagesAlpha3("GB"))
	})
})

describe("ES_PROVINCE_CO_OFFICIAL_LANGUAGES", () => {
	it("names the sixteen provinces the statutes give a co-official language, each in ISO 639-3", () => {
		expect(ES_PROVINCE_CO_OFFICIAL_LANGUAGES.size).toBe(16)

		for (const codes of ES_PROVINCE_CO_OFFICIAL_LANGUAGES.values()) {
			for (const code of codes) {
				expect(code).toMatch(/^[a-z]{3}$/u)
			}
		}

		expect(coOfficialLanguagesForProvince("Madrid")).toEqual([])
	})
})
