// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The countries the OSM rooftop build has an extract for, and the street locale each folds under.
 *   The locale comes from `streetLocaleForCountry` in `@mailwoman/resolver-wof-sqlite/street`, which the
 *   reader also calls, so a build and a query fold one street to one key.
 */

import { createStreetLocaleRegistry, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street"

/**
 * The countries with an OSM rooftop extract, in ISO 3166-1 alpha-2.
 *
 * AU's extract is built from G-NAF rather than OSM and lives in this provider's home.
 */
const OSM_EXTRACT_COUNTRIES = ["gb", "nz", "au", "fr", "de", "nl", "ca", "pl", "vn", "id", "pk"] as const

const registry = createStreetLocaleRegistry(
	OSM_EXTRACT_COUNTRIES,
	"Build its OSM rooftop extract and add it to OSM_EXTRACT_COUNTRIES."
)

/**
 * The street locale an OSM extract country folds under.
 *
 * @throws For a country without an OSM extract.
 */
export function streetLocaleForOSMCountry(countryCode: string): StreetLocale {
	return registry.localeFor(countryCode)
}

/**
 * The countries with an OSM rooftop extract, for CLI validation and help text.
 */
export function supportedOSMCountries(): string[] {
	return registry.supported()
}
