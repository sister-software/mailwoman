// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Build/probe consistency is the only interface the locale normalizer must hold:
 *   the OSM `addr:street` tag and the parser's `street` constituent must fold to the same key.
 *
 *   These cases lock the FR/DE/NL folding (and the Paris acceptance key)
 *   so a future tweak can't silently desync the two sides.
 */

import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street"
import { expect, test } from "vitest"

import { streetLocaleForOSMCountry, supportedOSMCountries } from "#street-locale"

test("fr: the Paris acceptance address keys consistently", () => {
	const key = normalizeStreetForKeyLocale("Rue du Chevaleret", streetLocaleForOSMCountry("fr"))
	expect(key).toBe("rue du chevaleret")
	// however a downstream source spells it, it folds to the same key
	expect(normalizeStreetForKeyLocale("rue du chevaleret", streetLocaleForOSMCountry("fr"))).toBe(key)
})

test("fr: leading type abbreviations + Saint expand", () => {
	expect(normalizeStreetForKeyLocale("Av. des Champs-Élysées", streetLocaleForOSMCountry("fr"))).toBe(
		"avenue des champs elysees"
	)

	expect(normalizeStreetForKeyLocale("Bd Saint-Germain", streetLocaleForOSMCountry("fr"))).toBe(
		"boulevard saint germain"
	)

	expect(normalizeStreetForKeyLocale("Rue St-Honoré", streetLocaleForOSMCountry("fr"))).toBe("rue saint honore")

	expect(normalizeStreetForKeyLocale("Pl. de la République", streetLocaleForOSMCountry("fr"))).toBe(
		"place de la republique"
	)
})

test("de: glued -str(.) / -straße all fold to -strasse", () => {
	const k = "lindenstrasse"
	expect(normalizeStreetForKeyLocale("Lindenstraße", streetLocaleForOSMCountry("de"))).toBe(k)
	expect(normalizeStreetForKeyLocale("Lindenstr.", streetLocaleForOSMCountry("de"))).toBe(k)
	expect(normalizeStreetForKeyLocale("Lindenstr", streetLocaleForOSMCountry("de"))).toBe(k)
	expect(normalizeStreetForKeyLocale("lindenstrasse", streetLocaleForOSMCountry("de"))).toBe(k)
	// a non-str name is untouched
	expect(normalizeStreetForKeyLocale("Marienplatz", streetLocaleForOSMCountry("de"))).toBe("marienplatz")
})

test("nl: glued -str folds to -straat", () => {
	expect(normalizeStreetForKeyLocale("Kerkstraat", streetLocaleForOSMCountry("nl"))).toBe("kerkstraat")
	expect(normalizeStreetForKeyLocale("Kerkstr.", streetLocaleForOSMCountry("nl"))).toBe("kerkstraat")
	expect(normalizeStreetForKeyLocale("Kerkstr", streetLocaleForOSMCountry("nl"))).toBe("kerkstraat")
})

test("en: GB/NZ street suffix surfaces key consistently", () => {
	expect(normalizeStreetForKeyLocale("Miramar North Rd", streetLocaleForOSMCountry("gb"))).toBe(
		normalizeStreetForKeyLocale("Miramar North Road", streetLocaleForOSMCountry("gb"))
	)

	expect(normalizeStreetForKeyLocale("Fellbrook St", streetLocaleForOSMCountry("gb"))).toBe(
		normalizeStreetForKeyLocale("Fellbrook Street", streetLocaleForOSMCountry("gb"))
	)

	expect(normalizeStreetForKeyLocale("Avery Hill Rd", streetLocaleForOSMCountry("gb"))).toBe(
		normalizeStreetForKeyLocale("Avery Hill Road", streetLocaleForOSMCountry("gb"))
	)
})

test("streetLocaleForOSMCountry: folds each extract country under the locale its extract was built with", () => {
	// The locales every OSM extract was built under before the locale came from one table.
	const built = {
		gb: "en",
		nz: "en",
		au: "en",
		fr: "fr",
		de: "de",
		nl: "nl",
		ca: "en",
		pl: "pl",
		vn: "vn",
		id: "id",
		pk: "en",
	}

	for (const [country, locale] of Object.entries(built)) {
		expect(streetLocaleForOSMCountry(country)).toBe(locale)
	}

	expect(supportedOSMCountries().toSorted()).toEqual(Object.keys(built).toSorted())
	expect(() => streetLocaleForOSMCountry("xx")).toThrow(/No database is registered/)
})
