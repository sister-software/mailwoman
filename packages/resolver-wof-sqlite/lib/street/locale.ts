// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The street locale every country's address keys are folded under, for builders and readers alike.
 */

import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"

import type { StreetLocale } from "#street/normalize"

/**
 * The locale whose rules fold streets written in each language, keyed by the two-letter
 * ISO 639-1 code `OFFICIAL_LANGUAGES` lists first among a language's spellings.
 */
const STREET_LOCALE_BY_LANGUAGE: ReadonlyMap<string, StreetLocale> = new Map([
	["en", "en"],
	["es", "es"],
	["fr", "fr"],
	["de", "de"],
	["it", "it"],
	["nl", "nl"],
	["pl", "pl"],
	["vi", "vn"],
	["id", "id"],
	["zh", "zh"],
])

/**
 * Countries whose official languages span several locales, with the locale their
 * published address databases were built under.
 *
 * Canada's OSM extract folds under `en`, and `streetLocaleForSurface` routes a
 * street that opens with a French type word to `fr`.
 */
const STREET_LOCALE_EXCEPTIONS: ReadonlyMap<string, StreetLocale> = new Map([["CA", "en"]])

/**
 * The locale a country's streets fold under: its exception when it has one, else the one locale
 * its official languages have rules in, else `und`, the shared fold with no language's abbreviations.
 *
 * The answer covers every ISO 3166-1 country, so a builder and a reader that
 * both call this fold one street to one key.
 * A country whose official languages span several locales folds under `und`
 * until its built databases name one in {@link STREET_LOCALE_EXCEPTIONS}.
 */
export function streetLocaleForCountry(countryCode: string): StreetLocale {
	const country = countryCode.trim().toUpperCase()
	const exception = STREET_LOCALE_EXCEPTIONS.get(country)

	if (exception) return exception

	const locales = new Set<StreetLocale>()

	for (const language of OFFICIAL_LANGUAGES[country]?.official ?? []) {
		const locale = STREET_LOCALE_BY_LANGUAGE.get(language)

		if (locale) {
			locales.add(locale)
		}
	}

	return locales.size === 1 ? [...locales][0]! : "und"
}
