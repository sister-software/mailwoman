/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The US Census Bureau geocoder's JSON response, as this package consumes it.
 *
 *   The Census geocoder is tiger with an http front door: every match is an interpolation along a
 *   tiger/Line address range, so the response types are built from `@mailwoman/tiger`'s branded types and
 *   this package depends on `@mailwoman/tiger` rather than the reverse.
 */

import type {
	DirectionalAbbreviation,
	USPSStandardSuffixAbbreviation,
	ZipCode,
	ZipCodePlusFour,
} from "@mailwoman/codex/us"
import type { InternalPointCoordinates } from "@mailwoman/spatial"
import type {
	AdminLevel1Abbreviation,
	AdminLevel1Code,
	FIPSBlockCode,
	FIPSBlockGeoID,
	FIPSBlockGroupCode,
	FIPSCountyCode,
	FIPSTractCode,
	LandWaterBlockType,
	LegalStatisticalAreaDescription,
	TIGERClassCode,
	TIGERFunctionalStatus,
	TIGERGeographicClassification,
} from "@mailwoman/tiger"

/**
 * Which mtdb vintage the locator searches.
 *
 * Benchmarks are re-issued twice yearly.
 *
 * A const object rather than an `enum`, because `erasableSyntaxOnly` is on repo-wide.
 */
export const CensusBenchmarkName = {
	/**
	 * Public Address Ranges — Current Benchmark: the default, whatever mtdb extract is newest.
	 */
	Current: "Public_AR_Current",
	ACS2023: "Public_AR_ACS2023",
	/**
	 * Public Address Ranges — Census 2020 Benchmark, to pair with the 2020 vintage.
	 */
	Census2020: "Public_AR_Census2020",
} as const

/**
 * The benchmark identifier a Census request can carry.
 */
export type CensusBenchmarkName = (typeof CensusBenchmarkName)[keyof typeof CensusBenchmarkName]

/**
 * Which geography vintage a `geographies/*` lookup reports blocks/tracts against.
 *
 * Benchmark and vintage must agree — `Public_AR_Current` pairs with `Current_Current`
 * and `Public_AR_Census2020` with `Census2020_Census2020` — and the client's two methods
 * each pin a compatible pair rather than exposing them as independent knobs.
 */
export const CensusVintageName = {
	Current: "Current_Current",
	Census2020: "Census2020_Census2020",
} as const

/**
 * The vintage identifier a `geographies/*` lookup can carry.
 */
export type CensusVintageName = (typeof CensusVintageName)[keyof typeof CensusVintageName]

/**
 * The benchmark descriptor echoed back inside `result.input`.
 */
export interface CensusBenchmarkMetadata {
	id: string
	benchmarkName: CensusBenchmarkName | string
	benchmarkDescription: string
	isDefault: boolean
}

/**
 * The vintage descriptor echoed back inside `result.input` on a `geographies/*` lookup.
 */
export interface CensusVintageMetadata {
	id: string
	vintageName: CensusVintageName | string
	vintageDescription: string
	isDefault: boolean
}

/**
 * The tiger/Line segment a match was interpolated along.
 */
export interface CensusTigerLine {
	side: "L" | "R"
	/**
	 * The TIGER/Line segment identifier.
	 * Its wire key is `tigerLineId` with a lowercase `d`.
	 *
	 * @pattern ^\d+$
	 */
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- the Census API's own wire key rather than a name we chose. renaming it to `tigerLineID` would silently read `undefined` off every response.
	tigerLineId: string
}

/**
 * The Census geocoder's decomposition of a matched street address.
 *
 * Every value comes back uppercase because that is the provider's form (USPS Publication 28),
 * not a normalization this package applies.
 *
 * The provider returns seven slots.
 * Mailwoman's `ComponentTag` vocabulary has four tags for the same span.
 * `census-parser.ts` documents the mapping.
 */
export interface CensusAddressComponents {
	/**
	 * A word preceding and modifying the street name but separated from it — the `old` in `123 Old Main St`.
	 */
	preQualifier: string
	/**
	 * The directional preceding the street name — the `N` in `123 N Main St`.
	 */
	preDirection: DirectionalAbbreviation | string
	/**
	 * A street type preceding the name — the `avenue` in `Avenue of the Americas`.
	 */
	preType: string
	/**
	 * The street name proper, with no pre- or suffix types — `silver hill`, `main`, `willow glen`.
	 */
	streetName: string
	/**
	 * The type following the name — `ST`, `AVE`, `blvd`.
	 */
	suffixType: USPSStandardSuffixAbbreviation | string
	/**
	 * The directional following the name — the `E` in `123 N Main St E`.
	 */
	suffixDirection: DirectionalAbbreviation | string
	/**
	 * A word following and modifying the name — the `extended` in `123 East End Avenue Extended`.
	 */
	suffixQualifier: string
	/**
	 * The city, uppercase; `locality` in mailwoman's vocabulary.
	 */
	city: string
	/**
	 * The two-letter state abbreviation.
	 */
	state: AdminLevel1Abbreviation | string
	/**
	 * The ZIP code: the geocoder returns the five-digit form, with the plus-four
	 * variant admitted for completeness.
	 */
	zip: ZipCode | ZipCodePlusFour | string
	/**
	 * The low end of the tiger address range this match was interpolated within.
	 */
	fromAddress: string
	/**
	 * The high end of the tiger address range this match was interpolated within.
	 */
	toAddress: string
}

/**
 * One entry of `result.addressMatches`.
 */
export interface CensusAddressMatch {
	/**
	 * The address as matched — the USPS-normalized single line,
	 * e.g. `4600 silver hill RD, washington, DC, 20233`.
	 */
	matchedAddress: string
	addressComponents: CensusAddressComponents
	tigerLine: CensusTigerLine
	/**
	 * `{ x: longitude, y: latitude }` uses the Census geocoder's axis names.
	 *
	 * `@mailwoman/spatial` defines the same shape as `InternalPointCoordinates`.
	 */
	coordinates: InternalPointCoordinates
}

/**
 * A `Census Blocks` entry from a `geographies/*` lookup.
 * `@mailwoman/tiger` types every field as a TIGER attribute.
 */
export interface CensusBlockGeography {
	/**
	 * Land area, square metres.
	 */
	AREALAND: number
	/**
	 * Water area, square metres.
	 */
	AREAWATER: number
	BASENAME: FIPSBlockCode | string
	BLKGRP: FIPSBlockGroupCode | string
	BLOCK: FIPSBlockCode | string
	CENTLAT: string
	CENTLON: string
	COUNTY: FIPSCountyCode | string
	FUNCSTAT: TIGERFunctionalStatus | string
	GEOID: FIPSBlockGeoID | string
	/**
	 * Housing units in the block, 2020 decennial.
	 */
	HU100: number
	INTPTLAT: string
	INTPTLON: string
	LSADC: LegalStatisticalAreaDescription | string
	LWBLKTYP: LandWaterBlockType | string
	MTFCC: TIGERClassCode | string
	NAME: string
	OBJECTID: number
	OID: string
	/**
	 * Population in the block, 2020 decennial.
	 */
	POP100: number
	STATE: AdminLevel1Code | string
	SUFFIX: string
	TRACT: FIPSTractCode | string
	UR: TIGERGeographicClassification | string
}

/**
 * An address match from a `geographies/*` lookup — the same match, plus the geography layers requested.
 */
export interface CensusGeographyMatch extends CensusAddressMatch {
	geographies: {
		"Census Blocks": CensusBlockGeography[]
		[layer: string]: unknown
	}
}

/**
 * The Census geocoder response envelope.
 * It nests `input` inside `result`.
 */
export interface CensusGeocodeResponse<Match extends CensusAddressMatch = CensusAddressMatch> {
	result: {
		input?: {
			address?: Record<string, string> | string
			benchmark?: CensusBenchmarkMetadata
			vintage?: CensusVintageMetadata
		}
		addressMatches: Match[]
	}
}
