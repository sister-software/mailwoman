// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The countries the BAN rooftop build has an extract for, and the street locale each folds under.
 *
 *   The locale comes from `streetLocaleForCountry` in `@mailwoman/resolver-wof-sqlite/street`,
 *   which the reader also calls.
 *   This module stays apart from `region-database-provider.ts`, which opens the
 *   SQLite lookup, so the locale can be tested without a database.
 */

import { createStreetLocaleRegistry, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street"

/**
 * The countries with a BAN extract.
 * BAN is the French national register.
 */
const BAN_EXTRACT_COUNTRIES = ["fr"] as const

const registry = createStreetLocaleRegistry(
	BAN_EXTRACT_COUNTRIES,
	"Build its BAN extract and add it to BAN_EXTRACT_COUNTRIES."
)

/**
 * The street locale a BAN extract country folds under.
 *
 * @throws For a country without a BAN extract.
 */
export function streetLocaleForBANCountry(countryCode: string): StreetLocale {
	return registry.localeFor(countryCode)
}

/**
 * The countries with a BAN extract, for CLI validation and provider filtering.
 */
export function supportedBANCountries(): string[] {
	return registry.supported()
}
