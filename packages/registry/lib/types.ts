// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Branded identifier types.
 *
 *   A brand is a declaration-only unique symbol, so a branded value is a plain string at runtime
 *   and the compiler refuses to pass one namespace's code where another's is expected.
 *
 *   A branded value records that a validator accepted it under a documented profile at the time of the call.
 *   The issuing authority's later assignments are outside what the brand records.
 */

/**
 * ISO 3166-1 country code namespaces.
 *
 * ISO 3166-2 codes subdivisions and is a separate brand, outside country codes.
 */
export declare namespace ISO {
	const $CountryCode_3166_1_Alpha2: unique symbol
	const $CountryCode_3166_1_Alpha3: unique symbol
	const $CountryCode_3166_1_Numeric: unique symbol

	/**
	 * A two-letter country code the profile holds as officially assigned, such as `GB`.
	 */
	type CountryCode_3166_1_Alpha2 = string & { readonly [$CountryCode_3166_1_Alpha2]: true }

	/**
	 * A three-letter country code the profile holds as officially assigned, such as `GBR`.
	 */
	type CountryCode_3166_1_Alpha3 = string & { readonly [$CountryCode_3166_1_Alpha3]: true }

	/**
	 * A three-digit country code, kept as a string so `036` keeps its leading zero.
	 */
	type CountryCode_3166_1_Numeric = string & { readonly [$CountryCode_3166_1_Numeric]: true }
}

/**
 * IATA location code namespaces.
 */
export declare namespace IATA {
	const $LocationCode: unique symbol
	const $AirportCode: unique symbol

	/**
	 * A three-letter IATA location code of any kind.
	 */
	type LocationCode = string & { readonly [$LocationCode]: true }

	/**
	 * A location code the profile holds for an airport.
	 *
	 * The open profile holds only airports, so every code it accepts is one of these.
	 * A metropolitan code is outside the profile and is refused.
	 */
	type AirportCode = LocationCode & { readonly [$AirportCode]: true }
}

/**
 * ICAO location indicator namespace.
 */
export declare namespace ICAO {
	const $LocationIndicator: unique symbol

	/**
	 * A four-character ICAO location indicator, such as `EGLL`.
	 */
	type LocationIndicator = string & { readonly [$LocationIndicator]: true }
}

/**
 * The status a country record holds.
 */
export const CountryStatus = {
	OfficiallyAssigned: "officially-assigned",
	FormerlyUsed: "formerly-used",
} as const

export type CountryStatus = (typeof CountryStatus)[keyof typeof CountryStatus]

/**
 * How an airport record's country column relates to ISO 3166-1.
 */
export const AirportCountryStatus = {
	ISO3166_1: "iso3166-1",
	SourceExtension: "source-extension",
	Unstated: "unstated",
} as const

export type AirportCountryStatus = (typeof AirportCountryStatus)[keyof typeof AirportCountryStatus]

/**
 * One country record as the records artifact holds it.
 */
export interface CountryRecord {
	entityID: string
	alpha2: string
	alpha3: string
	numeric: string
	name: string
	status: CountryStatus
}

/**
 * One airport record as the records artifact holds it.
 */
export interface AirportRecord {
	entityID: string
	iata: IATA.AirportCode
	icao: ICAO.LocationIndicator | null
	name: string
	facility: string
	scheduledService: boolean
	latitude: number
	longitude: number
	/**
	 * The country as the source spells it, or null.
	 */
	country: string | null
	countryStatus: AirportCountryStatus
	municipality: string | null
	isoRegion: string | null
}
