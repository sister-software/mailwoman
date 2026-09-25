/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The US Census Bureau geocoder's JSON response, as this package consumes it.
 *
 *   the census geocoder is tiger with an http front door. Every match it returns is an interpolation
 *   along a tiger/Line address range — `tigerLine.tigerLineId` names the segment, `side` says which
 *   kerb, and `addressComponents.fromAddress`/`toAddress` are the range's endpoints. That is why the
 *   response types below are built almost entirely out of `@mailwoman/tiger`'s existing branded types
 *   (`FIPSBlockGeoID`, `TIGERClassCode`, `LegalStatisticalAreaDescription`, …) rather than fresh ones:
 *   the fields are tiger fields, and this package depends on `@mailwoman/tiger` rather than the
 *   reverse so the published package takes no dependency on an oracle client.
 *
 *   It also means {@linkcode CensusAddressMatch} can never be a rooftop geocode. See
 *   `census-parser.ts`'s tier note.
 *
 *   Ported from `isp-nexus/universe/mailwoman/sdk/census/index.ts`. Three shape corrections were made
 *   against the live API, each noted at the field it affects: the response envelope's nesting,
 *   the missing `preDirection` component, and the type of `matchedAddress`.
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
 * A const object rather than an `enum` (the isp-nexus original used one) —
 * `erasableSyntaxOnly` is on repo-wide.
 */
export const CensusBenchmarkName = {
	/**
	 * Public Address Ranges — Current Benchmark.
	 *
	 * The default: whatever mtdb extract is newest.
	 */
	Current: "Public_AR_Current",
	/**
	 * Public Address Ranges — ACS2023 Benchmark.
	 */
	ACS2023: "Public_AR_ACS2023",
	/**
	 * Public Address Ranges — Census 2020 Benchmark.
	 *
	 * The one to pair with the 2020 vintage.
	 */
	Census2020: "Public_AR_Census2020",
} as const

/**
 * Which mtdb vintage the locator searches.
 */
export type CensusBenchmarkName = (typeof CensusBenchmarkName)[keyof typeof CensusBenchmarkName]

/**
 * Which geography vintage a `geographies/*` lookup reports blocks/tracts against.
 *
 * Benchmark and vintage must agree.
 * `Public_AR_Current` pairs with `Current_Current`, and `Public_AR_Census2020` with
 * `Census2020_Census2020`; a mismatched pair is rejected by the API.
 *
 * The client's two methods each pin a compatible pair rather than exposing them as independent knobs.
 */
export const CensusVintageName = {
	Current: "Current_Current",
	Census2020: "Census2020_Census2020",
} as const

/**
 * Which geography vintage a `geographies/*` lookup reports blocks/tracts against.
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
	/**
	 * Which side of the segment the address falls on.
	 */
	side: "L" | "R"
	/**
	 * The tiger/Line segment identifier.
	 *
	 * Note the wire key is `tigerLineId` with a lowercase `d`.
	 * A string interface, so the house acronym-casing rule does not apply to it.
	 * The TS property name must match the wire.
	 *
	 * @pattern ^\d+$
	 */
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- the Census API's own wire key rather than a name we chose. renaming it to `tigerLineID` would silently read `undefined` off every response.
	tigerLineId: string
}

/**
 * The Census geocoder's decomposition of a matched street address.
 *
 * Every value comes back uppercase.
 * That is the provider's form (USPS Publication 28), not a normalization this package applies —
 * contrast `google-parser.ts`, which explicitly removed the original's uppercasing because it was ours.
 *
 * Seven slots, and mailwoman's `ComponentTag` vocabulary has four for the same span.
 * `census-parser.ts` documents the fold.
 */
export interface CensusAddressComponents {
	/**
	 * A word preceding and modifying the street name but separated from it — the `old` in `123 Old Main St`.
	 */
	preQualifier: string
	/**
	 * The directional preceding the street name — the `N` in `123 N Main St`.
	 *
	 * Absent from the isp-nexus interface, which listed `preType` but not this.
	 * The live API returns it, so a US address with a pre-directional had that directional
	 * silently dropped from every parse the original produced.
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
	 * The city, uppercase.
	 *
	 * `locality` in mailwoman's vocabulary.
	 */
	city: string
	/**
	 * The two-letter state abbreviation.
	 */
	state: AdminLevel1Abbreviation | string
	/**
	 * The ZIP code.
	 *
	 * The geocoder returns the five-digit form.
	 * The plus-four variant is admitted for completeness.
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
	 *
	 * Typed `string`, unlike the isp-nexus original, which annotated this field
	 * as `PostalAddressPart.FormattedAddress`.
	 * An enum member used in type position, which is the literal type of that member's value.
	 *
	 * The field was therefore declared to hold the string `"formattedAddress"` rather than an address.
	 *
	 * It typechecked because every consumer only passed it on to something taking a `string`.
	 */
	matchedAddress: string
	addressComponents: CensusAddressComponents
	tigerLine: CensusTigerLine
	/**
	 * `{ x: longitude, y: latitude }`.
	 *
	 * The Census geocoder's own axis naming, which is `InternalPointCoordinates` in
	 * `@mailwoman/spatial` and is accepted directly by `GeoPoint`'s constructor.
	 */
	coordinates: InternalPointCoordinates
}

/**
 * A `Census Blocks` entry from a `geographies/*` lookup.
 *
 * Every field is a tiger attribute.
 * The types come from `@mailwoman/tiger`.
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
 * The response envelope.
 *
 * `input` is nested inside `result`.
 * The isp-nexus original declared it as a sibling (`{ input, result: { addressMatches } }`),
 * which typechecked only because no code ever read it.
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
