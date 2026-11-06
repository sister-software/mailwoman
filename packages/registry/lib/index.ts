// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/registry`: standardized identifiers and their relationships, compiled from pinned open sources.
 *
 *   The root entry re-exports the narrow modules. Every export is a function or a type, and no module decodes an
 *   artifact until its first call, so importing the root costs the modules the bundler keeps and no table.
 *   Import a subpath such as `@mailwoman/registry/iso3166/alpha2` when a bundle must retain one table only.
 */

export type { ParseFailure, Parsed } from "#errors"
export { getAirportByIATA, airportsInCountry, airportRecordCount, airportRecordsHeader } from "#iata/airports/records"
export { isAirportCode, parseAirportCode } from "#iata/airports/validate"
export type { ArtifactInspection } from "#inspect"
export { inspectArtifact } from "#inspect"
export { isCountryCodeAlpha2, parseCountryCodeAlpha2 } from "#iso3166/alpha2"
export { isCountryCodeAlpha3, parseCountryCodeAlpha3 } from "#iso3166/alpha3"
export {
	countryRecordCount,
	countryRecordsHeader,
	getCountryByAlpha2,
	getCountryByAlpha3,
	getCountryByNumeric,
} from "#iso3166/records"
export { alpha2ForAlpha3, alpha2ForNumeric, alpha3ForAlpha2 } from "#iso3166/relations"
export type { Normalization } from "#normalize"
export { canonicalSpelling } from "#normalize"
export type { CodeMatch } from "#overlap/country-airport"
export { interpretCountryOrAirportCode, isCountryAirportCollision } from "#overlap/country-airport"
export type { AirportRecord, CountryRecord, IATA, ICAO, ISO } from "#types"
export { AirportCountryStatus, CountryStatus } from "#types"
