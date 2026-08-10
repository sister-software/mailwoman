/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build/probe CONSISTENCY is the only contract the locale normalizer must hold: the OSM `addr:street`
 *   tag and the parser's `street` constituent must fold to the same key. These cases lock the FR/DE/NL
 *   folding (and the Paris acceptance key) so a future tweak can't silently desync the two sides.
 */

import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { expect, test } from "vitest"

import { streetLocaleForCountry, supportedOSMCountries } from "./street-locale.ts"

test("fr: the Paris acceptance address keys consistently", () => {
	const key = normalizeStreetForKeyLocale("Rue du Chevaleret", "fr")
	expect(key).toBe("rue du chevaleret")
	// however a downstream source spells it, it folds to the same key
	expect(normalizeStreetForKeyLocale("rue du chevaleret", "fr")).toBe(key)
})

test("fr: leading type abbreviations + Saint expand", () => {
	expect(normalizeStreetForKeyLocale("Av. des Champs-Élysées", "fr")).toBe("avenue des champs elysees")
	expect(normalizeStreetForKeyLocale("Bd Saint-Germain", "fr")).toBe("boulevard saint germain")
	expect(normalizeStreetForKeyLocale("Rue St-Honoré", "fr")).toBe("rue saint honore")
	expect(normalizeStreetForKeyLocale("Pl. de la République", "fr")).toBe("place de la republique")
})

test("de: glued -str(.) / -straße all fold to -strasse", () => {
	const k = "lindenstrasse"
	expect(normalizeStreetForKeyLocale("Lindenstraße", "de")).toBe(k)
	expect(normalizeStreetForKeyLocale("Lindenstr.", "de")).toBe(k)
	expect(normalizeStreetForKeyLocale("Lindenstr", "de")).toBe(k)
	expect(normalizeStreetForKeyLocale("lindenstrasse", "de")).toBe(k)
	// a non-str name is untouched
	expect(normalizeStreetForKeyLocale("Marienplatz", "de")).toBe("marienplatz")
})

test("nl: glued -str folds to -straat", () => {
	expect(normalizeStreetForKeyLocale("Kerkstraat", "nl")).toBe("kerkstraat")
	expect(normalizeStreetForKeyLocale("Kerkstr.", "nl")).toBe("kerkstraat")
	expect(normalizeStreetForKeyLocale("Kerkstr", "nl")).toBe("kerkstraat")
})

test("en: GB/NZ street suffix surfaces key consistently", () => {
	expect(normalizeStreetForKeyLocale("Miramar North Rd", "en")).toBe(
		normalizeStreetForKeyLocale("Miramar North Road", "en")
	)

	expect(normalizeStreetForKeyLocale("Fellbrook St", "en")).toBe(normalizeStreetForKeyLocale("Fellbrook Street", "en"))
	expect(normalizeStreetForKeyLocale("Avery Hill Rd", "en")).toBe(normalizeStreetForKeyLocale("Avery Hill Road", "en"))
})

test("streetLocaleForCountry: maps the supported countries, throws otherwise", () => {
	expect(streetLocaleForCountry("GB")).toBe("en")
	expect(streetLocaleForCountry("nz")).toBe("en")
	expect(streetLocaleForCountry("FR")).toBe("fr")
	expect(streetLocaleForCountry("de")).toBe("de")
	expect(streetLocaleForCountry("nl")).toBe("nl")
	expect(supportedOSMCountries().toSorted()).toEqual(["de", "fr", "gb", "nl", "nz"])
	expect(() => streetLocaleForCountry("xx")).toThrow(/No street-normalization locale/)
})
