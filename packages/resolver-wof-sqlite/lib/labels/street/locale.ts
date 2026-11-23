// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The street locale every country's address keys are folded under, for builders and readers alike.
 */

import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"

import { parseStreetLocale, type StreetLocale } from "#labels/street/normalize"

/**
 * A table from a language or country code to the street locale each row spells.
 *
 * A row that spells no street locale stops the module from loading.
 */
function streetLocaleTable(
	rows: ReadonlyArray<readonly [code: string, spelling: string]>
): ReadonlyMap<string, StreetLocale> {
	return new Map(rows.map(([code, spelling]) => [code, parseStreetLocale(spelling)]))
}

/**
 * The locale whose rules fold streets written in each language, keyed by the two-letter
 * ISO 639-1 code `OFFICIAL_LANGUAGES` lists first among a language's spellings.
 */
const STREET_LOCALE_BY_LANGUAGE = streetLocaleTable([
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
 * The locale of a country whose official languages select no one row of rules.
 */
const UNDETERMINED_STREET_LOCALE = parseStreetLocale("und")

/**
 * Countries whose built address databases fold under a locale their official languages don't select.
 *
 * Each row records how that country's databases were keyed, since a built database records no street locale.
 *
 * Canada's official languages span two locales.
 * Its OSM extract folds under `en`, and `streetLocaleForSurface` routes a street
 * that opens with a French type word to `fr`.
 *
 * The United States' state databases and address layer fold under `us`.
 * Their builders key every street under the English fold, so the reader leaves a
 * street such as `Promenade Blvd` to that fold too.
 */
const STREET_LOCALE_EXCEPTIONS = streetLocaleTable([
	["CA", "en"],
	["US", "us"],
])

/**
 * The locale a country's streets fold under: its exception when it has one, else the one locale
 * its official languages have rules in, else `und`, the shared fold with no language's abbreviations.
 *
 * The answer covers every ISO 3166-1 country, so a builder and a reader that
 * both call this fold one street to one key.
 * It is the one place a country is mapped to a street locale: every builder,
 * reader and artifact manifest reads it.
 *
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

	return locales.size === 1 ? [...locales][0]! : UNDETERMINED_STREET_LOCALE
}

/**
 * Creates the street-locale lookup for one source's built databases.
 *
 * `localeFor` answers {@link streetLocaleForCountry} for a country in `countries`
 * and throws for any other, since that source has built no database there to key a query for.
 * Every source therefore keys a country's streets under one locale.
 */
export function createStreetLocaleRegistry(
	countries: readonly string[],
	label: string
): { localeFor: (countryCode: string) => StreetLocale; supported: () => string[] } {
	const built = new Set(countries.map((country) => country.toLowerCase()))

	return {
		localeFor: (countryCode) => {
			if (!built.has(countryCode.toLowerCase())) {
				throw new Error(`No database is registered for country "${countryCode}". ${label}`)
			}

			return streetLocaleForCountry(countryCode)
		},
		supported: () => [...built],
	}
}
