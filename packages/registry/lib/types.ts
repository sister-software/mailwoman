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
 * BCP 47 namespaces, read from the IANA Language Subtag Registry.
 */
export declare namespace BCP47 {
	const $LanguageTag: unique symbol
	const $ScriptCode: unique symbol
	const $LanguageSubtag: unique symbol

	/**
	 * A well-formed, valid BCP 47 tag in canonical form, such as `ja-Jpan-JP` or `en-GB`.
	 */
	type LanguageTag = string & { readonly [$LanguageTag]: true }

	/**
	 * An ISO 15924 script code the registry holds, in its canonical title case, such as `Latn` or `Jpan`.
	 */
	type ScriptCode = string & { readonly [$ScriptCode]: true }

	/**
	 * An ISO 639 language subtag the registry holds, in lowercase, such as `ja` or `yue`.
	 */
	type LanguageSubtag = string & { readonly [$LanguageSubtag]: true }
}

/**
 * The subtag types the IANA Language Subtag Registry defines.
 */
export const SubtagType = {
	Language: "language",
	Extlang: "extlang",
	Script: "script",
	Region: "region",
	Variant: "variant",
	Grandfathered: "grandfathered",
	Redundant: "redundant",
} as const

export type SubtagType = (typeof SubtagType)[keyof typeof SubtagType]

/**
 * One registry record as a table module holds it.
 *
 * `subtag` holds the subtag for the five subtag types and the whole tag for `grandfathered` and `redundant`.
 * A private-use range keeps its range spelling, such as `qaa..qtz`.
 *
 * Each table holds one subtag type, so a row leaves its type out.
 */
export interface SubtagRow {
	subtag: string
	descriptions: string[]
	deprecated?: string
	preferredValue?: string
	suppressScript?: string
	macrolanguage?: string
	scope?: string
	prefixes?: string[]
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

/**
 * Whether a grouping admits members or a publisher assigns countries to it.
 */
export const GroupingKind = {
	Organization: "organization",
	Classification: "classification",
} as const

export type GroupingKind = (typeof GroupingKind)[keyof typeof GroupingKind]

/**
 * The role a membership statement gives its country.
 * Only `member` counts as membership.
 */
export const MembershipRole = {
	Member: "member",
	Associate: "associate",
	Observer: "observer",
	Suspended: "suspended",
	Other: "other",
} as const

export type MembershipRole = (typeof MembershipRole)[keyof typeof MembershipRole]

/**
 * How a member's code relates to ISO 3166-1.
 *
 * `source-extension` is a code the publisher assigns outside ISO 3166-1, kept as the publisher
 * spells it, such as the World Bank's `XK` for Kosovo and `JG` for the Channel Islands.
 */
export const MemberCodeStatus = {
	OfficiallyAssigned: "officially-assigned",
	FormerlyUsed: "formerly-used",
	SourceExtension: "source-extension",
} as const

export type MemberCodeStatus = (typeof MemberCodeStatus)[keyof typeof MemberCodeStatus]

/**
 * A date a source states, with the precision it states it at.
 *
 * `date` is `YYYY-MM-DD`, with the month and day set to `01` when the precision leaves them unstated.
 */
export interface StatedDate {
	date: string
	precision: "year" | "month" | "day"
}

/**
 * One grouping as the groupings table holds it.
 */
export interface GroupingRecord {
	id: string
	name: string
	kind: GroupingKind
	/**
	 * The source and the selector the members were read through, such as `wikidata:Q458 P463`.
	 */
	source: string
	/**
	 * The publication date of a classification's source, or null for an organization.
	 */
	asOf: string | null
	/**
	 * The reasons the normalizer couldn't classify the grouping's statements.
	 * A blocked grouping answers no membership question.
	 */
	blockedBy: string[]
}

/**
 * One membership interval: a country's place in a grouping between two stated dates.
 */
export interface MembershipRow {
	grouping: string
	code: string
	codeStatus: MemberCodeStatus
	role: MembershipRole
	/**
	 * The start, or null when the source states none.
	 * A null start is unknown rather than the epoch.
	 */
	start: StatedDate | null
	end: StatedDate | null
	/**
	 * The statement or source row the interval was read from, such as `wikidata:Q145-…`.
	 */
	evidence: string
}
