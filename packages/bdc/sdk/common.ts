/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file BDC file metadata model. It defines dictionaries for FCC `bdc_file` listing rows.
 *   It also defines the raw-to-parsed record shape and file-ordering comparators.
 */

import type { Tagged } from "type-fest"

import type { BroadbandTechnologyCode } from "#technologies"

/**
 * Unique identifier for an FCC BDC broadband provider.
 *
 * @category BDC
 * @category FCC
 */
export type ProviderID = Tagged<number, "ProviderID">

/**
 * The data type of the file, e.g. what kind of data is in the file.
 *
 * @category BDC
 * @category FCC
 */
export const BDCFilingDataType = {
	/**
	 * The file contains data about the availability of broadband with a specific provider.
	 */
	Availability: "availability",
	/**
	 * The file contains data about the challenge process.
	 */
	Challenge: "challenge",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCFilingDataType = (typeof BDCFilingDataType)[keyof typeof BDCFilingDataType]

/**
 * @category BDC
 * @category FCC
 */
export const BDCGISFileType = {
	ShapeFile: 1,
	GeoPackage: 2,
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCGISFileType = (typeof BDCGISFileType)[keyof typeof BDCGISFileType]

/**
 * The type of file, e.g. what format the file is in.
 *
 * @category BDC
 * @category FCC
 */
export const BDCFileFormat = {
	CSV: "csv",
	GIS: "gis",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCFileFormat = (typeof BDCFileFormat)[keyof typeof BDCFileFormat]

/**
 * @category BDC
 * @category FCC
 */
export const BDCFileCategory = {
	Provider: "Provider",
	Summary: "Summary",
	State: "State",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCFileCategory = (typeof BDCFileCategory)[keyof typeof BDCFileCategory]

/**
 * Subcategories the live API accepts for `category=Provider`, per the April 2025 BDC Public
 * Data API specification, verified against the live endpoint on 2026-10-05 (#2465).
 *
 * @category BDC
 * @category FCC
 */
export const BDCProviderSubCategory = {
	LocationCoverage: "Location Coverage",
	HexagonCoverage: "Hexagon Coverage",
	RawCoverage: "Raw Coverage",
	SupportingData: "Supporting Data",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCProviderSubCategory = (typeof BDCProviderSubCategory)[keyof typeof BDCProviderSubCategory]

/**
 * Subcategories the live API accepts for `category=Summary`, per the April 2025 specification,
 * verified against the live endpoint on 2026-10-05 (#2465).
 *
 * @category BDC
 * @category FCC
 */
export const BDCSummarySubCategory = {
	SummaryByGeographyTypeCensusPlace: "Summary by Geography Type - Census Place",
	SummaryByGeographyTypeOtherGeographies: "Summary by Geography Type - Other Geographies",
	ProviderSummaryByGeography: "Provider Summary by Geography Type",
	ProviderSummary: "Provider Summary",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCSummarySubCategory = (typeof BDCSummarySubCategory)[keyof typeof BDCSummarySubCategory]

/**
 * Subcategories the live API accepts for `category=State`, per the April 2025 specification,
 * verified against the live endpoint on 2026-10-05 (#2465).
 *
 * Technology is a separate `technology_type` query parameter rather than a subcategory.
 *
 * @category BDC
 * @category FCC
 */
export const BDCStateSubCategory = {
	ProviderList: "Provider List",
	LocationCoverage: "Location Coverage",
	HexagonCoverage: "Hexagon Coverage",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCStateSubCategory = (typeof BDCStateSubCategory)[keyof typeof BDCStateSubCategory]

/**
 * Technology values for the listing endpoint's optional `technology_type` query parameter.
 *
 * @category BDC
 * @category FCC
 */
export const BDCTechnologyType = {
	FixedBroadband: "Fixed Broadband",
	MobileBroadband: "Mobile Broadband",
	MobileVoice: "Mobile Voice",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCTechnologyType = (typeof BDCTechnologyType)[keyof typeof BDCTechnologyType]

/**
 * Speed tiers for the listing endpoint's optional `speed_tier` query parameter,
 * valid for `category=Provider` hexagon and raw coverage.
 *
 * @category BDC
 * @category FCC
 */
export const BDCSpeedTier = {
	"35/3": "35/3",
	"7/1": "7/1",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCSpeedTier = (typeof BDCSpeedTier)[keyof typeof BDCSpeedTier]

export type BDCSubCategory = BDCProviderSubCategory | BDCStateSubCategory | BDCSummarySubCategory

/**
 * A single row from the FCC's BDC file listing, as returned by the API before parsing.
 *
 * @category BDC
 * @category FCC
 */
export interface RawBDCFile {
	file_id: number
	category: BDCFileCategory
	subcategory: BDCSubCategory
	/**
	 * Comma-separated list of technology codes.
	 *
	 * Nullable in live data: the FCC's `/map/downloads/listAvailabilityData` response includes
	 * `technology_code: null` for at least some State-category rows (first observed in the live
	 * FCC smoke test, see `.superpowers/sdd/2026-07-30-bdc-2b-plan/live-smoke-findings.md`).
	 * Guarded in {@linkcode parseRawBDCFile} — a null value parses to an empty
	 * `technologyCodes` set rather than throwing.
	 *
	 * @see {@link BroadbandTechnologyCode}
	 */
	technology_code: string | null
	technology_code_desc: string
	/**
	 * 2-digit state or territory FIPS code.
	 *
	 * Loosely typed as `string` for now.
	 *
	 * Tighten it against `@mailwoman/tiger` if a downstream dictionary ever needs the literal union.
	 *
	 * Nullable in live data for rows not scoped to a specific state (e.g. Provider-category rows).
	 * Guarded in {@linkcode parseRawBDCFile} — a null value parses to an empty `stateCode` string.
	 */
	state_fips: string | null
	/**
	 * State or territory name.
	 *
	 * Loosely typed as `string`.
	 * The Nexus original was `StateName` (via `@isp.nexus/tiger`).
	 * Same deferral as `state_fips` above.
	 */
	state_name: string
	/**
	 * Nullable in live data for rows not scoped to a specific provider (e.g. State/Summary-category rows).
	 *
	 * Guarded in {@linkcode parseRawBDCFile} — a null value parses to a `providerID` of `0`.
	 */
	provider_id: string | null
	/**
	 * Nullable in live data — travels with `provider_id` (see above).
	 *
	 * Guarded in {@linkcode parseRawBDCFile} — a null value parses to an empty `providerName` string.
	 */
	provider_name: string | null
	file_type: string
	file_name: string
	record_count: string
}

/**
 * A parsed FCC BDC file-listing entry.
 *
 * @category BDC
 * @category FCC
 */
export interface BDCFile {
	/**
	 * Unique identifier for the file, defined by the FCC.
	 */
	fileID: number

	revision: Date
	vintage: Date

	/**
	 * The date the file was downloaded, parsed and stored in the database.
	 */
	synchronizedAt: Date | null

	/**
	 * The category of the file.
	 */
	category: BDCFileCategory
	/**
	 * The subcategory of the file.
	 */
	subcategory: BDCSubCategory
	/**
	 * The technology codes in the file.
	 *
	 * Empty when the raw `technology_code` was `null`.
	 */
	technologyCodes: Set<BroadbandTechnologyCode>
	/**
	 * The state or territory FIPS code.
	 *
	 * Loosely typed as `string`.
	 * See {@linkcode RawBDCFile} for the deferral.
	 * Empty string when the raw `state_fips` was `null`.
	 */
	stateCode: string
	/**
	 * The provider ID associated with the file.
	 *
	 * `0` when the raw `provider_id` was `null` (no specific provider — see {@linkcode RawBDCFile}).
	 */
	providerID: ProviderID
	/**
	 * The provider name associated with the file.
	 *
	 * Empty string when the raw `provider_name` was `null`.
	 */
	providerName: string
	/**
	 * The number of records in the file.
	 */
	recordCount: number
	/**
	 * The type of file, e.g. what format the file is in.
	 */
	fileType: string
	/**
	 * The name of the file, as provided by the FCC.
	 */
	fileName: string
}

const BDCFileNamePattern = /([A-Z])(\d+)_(\d{2})([a-z]{3})(\d{4})$/

const MonthAbbreviation = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
} as const

export type MonthAbbreviation = keyof typeof MonthAbbreviation

const VintageMonthLetter = {
	/**
	 * December
	 */
	D: 11,
	/**
	 * June
	 */
	J: 5,
}

type VintageMonthLetter = keyof typeof VintageMonthLetter

/**
 * Given a BDC file, parse the components of the file name.
 */
export function parseBDCFileTimestamps(fileName: string) {
	const match = fileName.match(BDCFileNamePattern)

	if (!match) throw new Error(`Invalid BDC file name: ${fileName}`)
	const [, vintageMonthLetter, vintageYearAbbreviation, revisionDay, revisionMonthAbbreviation, revisionYear] = match

	const revisionMonth = MonthAbbreviation[revisionMonthAbbreviation as MonthAbbreviation]
	const revision = new Date(Number.parseInt(revisionYear!, 10), revisionMonth, Number.parseInt(revisionDay!, 10))

	const vintageMonth = VintageMonthLetter[vintageMonthLetter as VintageMonthLetter]
	const vintageYear = Number.parseInt(`20${vintageYearAbbreviation}`, 10)

	const vintage = new Date(vintageYear, vintageMonth)

	return {
		revision,
		vintage,
	}
}

/**
 * Parses a raw BDC file-listing entry into a {@linkcode BDCFile}.
 */
export function parseRawBDCFile(raw: RawBDCFile): BDCFile {
	const parsedBDC: BDCFile = {
		...parseBDCFileTimestamps(raw.file_name),
		fileName: raw.file_name,
		fileType: raw.file_type,
		fileID: raw.file_id,
		recordCount: Number.parseInt(raw.record_count, 10),
		category: raw.category,
		subcategory: raw.subcategory,
		technologyCodes: new Set(
			raw.technology_code === null
				? []
				: raw.technology_code.split(",").map((code) => Number.parseInt(code, 10) as BroadbandTechnologyCode)
		),
		stateCode: raw.state_fips ?? "",
		providerID: (raw.provider_id === null ? 0 : Number.parseInt(raw.provider_id, 10)) as ProviderID,
		providerName: raw.provider_name ?? "",
		synchronizedAt: null,
	}

	return parsedBDC
}

/**
 * Comparator for sorting {@linkcode BDCFile} records ascending by revision date.
 */
export function compareRevisionAsc(a: BDCFile, b: BDCFile): number {
	return a.revision.getTime() - b.revision.getTime()
}

/**
 * Comparator for sorting {@linkcode BDCFile} records ascending by provider ID.
 */
export function compareProviderIDAsc(a: BDCFile, b: BDCFile): number {
	return a.providerID - b.providerID
}

/**
 * Comparator for sorting {@linkcode BDCFile} records ascending by state FIPS code.
 */
export function compareStateCodeAsc(a: BDCFile, b: BDCFile): number {
	return Number.parseInt(a.stateCode, 10) - Number.parseInt(b.stateCode, 10)
}
