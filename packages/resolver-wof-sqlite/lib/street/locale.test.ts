// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"
import { describe, expect, it } from "vitest"

import { streetLocaleForCountry } from "#street/locale"
import { normalizeStreetForKeyLocale, STREET_LOCALES } from "#street/normalize"

describe("streetLocaleForCountry", () => {
	it("folds a single-language country under that language's locale", () => {
		expect(streetLocaleForCountry("US")).toBe("en")
		expect(streetLocaleForCountry("fr")).toBe("fr")
		expect(streetLocaleForCountry("DE")).toBe("de")
		expect(streetLocaleForCountry("VN")).toBe("vn")
		expect(streetLocaleForCountry("TW")).toBe("zh")
		expect(streetLocaleForCountry("PK")).toBe("en")
	})

	it("keeps Canada under en, and folds another country of several rules languages under und", () => {
		expect(streetLocaleForCountry("CA")).toBe("en")
		expect(streetLocaleForCountry("BE")).toBe("und")
		expect(streetLocaleForCountry("CH")).toBe("und")
	})

	it("answers every ISO 3166-1 country with a locale the normalizer keys under", () => {
		const locales = new Set<string>(STREET_LOCALES)

		for (const country of Object.keys(OFFICIAL_LANGUAGES)) {
			expect(locales.has(streetLocaleForCountry(country))).toBe(true)
		}

		expect(streetLocaleForCountry("JP")).toBe("und")
	})

	it("folds an und street with the shared fold alone", () => {
		expect(normalizeStreetForKeyLocale("Rue de la Loi", "und")).toBe("rue de la loi")
		expect(normalizeStreetForKeyLocale("Bahnhofstraße", "und")).toBe("bahnhofstrasse")
	})
})
