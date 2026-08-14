/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file BDC file metadata model — dictionaries for the FCC's `bdc_file` listing rows, the
 *   raw-to-parsed record shape, and file-ordering comparators.
 */

import type { Tagged } from "type-fest"

import type { BroadbandTechnologyCode } from "./technologies.ts"

/**
 * Unique identifier for an FCC BDC broadband provider.
 *
 * Re-homed locally as `Tagged<number, ...>` — the Nexus original imported this from `@isp.nexus/fcc`
 * (`BroadbandProvider.ts`), where it's defined identically.
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
 * @category BDC
 * @category FCC
 */
export const BDCProviderSubCategory = {
	FixedBroadband: "Fixed Broadband",
	MobileBroadband: "Mobile Broadband",
	MobileVoice: "Mobile Voice",
	SupportingData: "Supporting Data",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCProviderSubCategory = (typeof BDCProviderSubCategory)[keyof typeof BDCProviderSubCategory]

/**
 * @category BDC
 * @category FCC
 */
export const BDCSummarySubCategory = {
	BroadbandSummaryByGeography: "Broadband Summary by Geography Type",
	ProviderSummaryByGeography: "Provider Summary by Geography Type",
	ProviderSummaryFixedBroadband: "Provider Summary - Fixed Broadband",
	ProviderSummaryMobileBroadband: "Provider Summary - Mobile Broadband",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCSummarySubCategory = (typeof BDCSummarySubCategory)[keyof typeof BDCSummarySubCategory]

/**
 * @category BDC
 * @category FCC
 */
export const BDCStateSubCategory = {
	FixedBroadband: "Fixed Broadband",
	MobileBroadband: "Mobile Broadband",
	MobileVoice: "Mobile Voice",
} as const

/**
 * @category BDC
 * @category FCC
 */
export type BDCStateSubCategory = (typeof BDCStateSubCategory)[keyof typeof BDCStateSubCategory]

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
	 * Nullable in live data: the FCC's `/map/downloads/listAvailabilityData` response carries `technology_code: null` for
	 * at least some State-category rows (first observed in the live FCC smoke test, see
	 * `.superpowers/sdd/2026-07-30-bdc-2b-plan/live-smoke-findings.md`). Guarded in {@linkcode parseRawBDCFile} — a null
	 * value parses to an empty `technologyCodes` set rather than throwing.
	 *
	 * @see {@link BroadbandTechnologyCode}
	 */
	technology_code: string | null
	technology_code_desc: string
	/**
	 * 2-digit state or territory FIPS code.
	 *
	 * Loosely typed as `string` for now. The Nexus original was `AdminLevel1Code` (via `@isp.nexus/tiger`); this port
	 * drops that dependency, same as `data-collection.ts`'s `FCCStateID`. Tighten it against `@mailwoman/tiger` if a
	 * downstream dictionary ever needs the literal union.
	 *
	 * Nullable in live data for rows not scoped to a specific state (e.g. Provider-category rows). Guarded in
	 * {@linkcode parseRawBDCFile} — a null value parses to an empty `stateCode` string.
	 */
	state_fips: string | null
	/**
	 * State or territory name.
	 *
	 * Loosely typed as `string` — the Nexus original was `StateName` (via `@isp.nexus/tiger`). Same deferral as
	 * `state_fips` above.
	 */
	state_name: string
	/**
	 * Nullable in live data for rows not scoped to a specific provider (e.g. State/Summary-category rows). Guarded in
	 * {@linkcode parseRawBDCFile} — a null value parses to a `providerID` of `0`.
	 */
	provider_id: string | null
	/**
	 * Nullable in live data — travels with `provider_id` (see above). Guarded in {@linkcode parseRawBDCFile} — a null
	 * value parses to an empty `providerName` string.
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
	 * The date the file was was downloaded, parsed, and stored in the database.
	 */
	synchronizedAt?: Date

	/**
	 * The category of the file.
	 */
	category: BDCFileCategory
	/**
	 * The subcategory of the file.
	 */
	subcategory: BDCSubCategory
	/**
	 * The technology codes in the file. Empty when the raw `technology_code` was `null`.
	 */
	technologyCodes: Set<BroadbandTechnologyCode>
	/**
	 * The state or territory FIPS code.
	 *
	 * Loosely typed as `string` — see {@linkcode RawBDCFile} for the deferral. Empty string when the raw `state_fips` was
	 * `null`.
	 */
	stateCode: string
	/**
	 * The provider ID associated with the file. `0` when the raw `provider_id` was `null` (no specific provider — see
	 * {@linkcode RawBDCFile}).
	 */
	providerID: ProviderID
	/**
	 * The provider name associated with the file. Empty string when the raw `provider_name` was `null`.
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
