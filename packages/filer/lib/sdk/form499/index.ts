/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Form 499 TSV columns, row types, classification mapping, and streaming parser.
 *   The parser validates all 17 columns and reports malformed rows with their file and line number.
 *   FRNs use the branded 10-digit format; holding and management companies remain separate fields.
 *   DC-agent data is retained as attributes only and must not imply a relationship between filers.
 */

import type { PathBuilderLike } from "path-ts"
import { TSVSpliterator } from "spliterator"

import { toFRN, type FRN } from "#frn"
import type { Form499Lifecycle } from "#sdk/form499/notes"

/**
 * The 17 Form 499 TSV columns in file order; the source has no header row.
 */
export const FORM_499_COLUMNS = [
	"form499ID",
	"frn",
	"lastFiledAt",
	"usfContributor",
	"legalNameOfCarrier",
	"doingBusinessAs",
	"principalCommType",
	"holdingCompany",
	"managementCompany",
	"hqAddress",
	"customerInquiriesTelephone",
	"customerInquiriesAddress",
	"dcAgentDisplayName",
	"dcAgentOrganizationName",
	"dcAgentTelephone",
	"dcAgentEmailAddress",
	"dcAgentAddress",
] as const satisfies readonly string[]

export type Form499Column = (typeof FORM_499_COLUMNS)[number]

/**
 * Parsed Form 499 filer row.
 */
export interface Form499Row {
	/**
	 * Form 499 filer ID as provided by the TSV.
	 */
	form499ID: string
	/**
	 * Valid 10-digit FRN, or `null` when the field is missing or invalid.
	 */
	frn: FRN | null
	/**
	 * Last-filed date as provided by the TSV; parsing occurs downstream.
	 */
	lastFiledAt: string
	/**
	 * Whether the source field is the literal `"TRUE"` after trimming.
	 */
	usfContributor: boolean
	legalNameOfCarrier: string
	doingBusinessAs: string
	/**
	 * Free-text classification input for {@linkcode classifyFiler}.
	 */
	principalCommType: string
	/**
	 * Holding company, representing ownership; distinct from the management company.
	 */
	holdingCompany: string
	/**
	 * Management company, representing operational control.
	 */
	managementCompany: string
	hqAddress: string
	customerInquiriesTelephone: string
	customerInquiriesAddress: string
	/**
	 * Registered agent display name; store as an attribute, not relationship evidence.
	 */
	dcAgentDisplayName: string
	dcAgentOrganizationName: string
	dcAgentTelephone: string
	dcAgentEmailAddress: string
	dcAgentAddress: string
	/**
	 * Lifecycle parsed from workbook notes; absent from the 17-column TSV.
	 *
	 * `undefined` means the source cannot report lifecycle, unlike an empty workbook note set.
	 */
	lifecycle?: Form499Lifecycle
	/**
	 * Sorted USPS codes for jurisdictions marked in the workbook; absent from the TSV.
	 *
	 * An empty array means no jurisdiction was marked; `undefined` means unavailable from the source.
	 */
	operatingStates?: string[]
}

/**
 * Classification values derived from `principalCommType` and `usfContributor`.
 */
export const FilerClassification = {
	IncumbentLEC: "incumbent_lec",
	CLEC: "clec",
	InterExchange: "interexchange",
	TollReseller: "toll_reseller",
	USFContributor: "usf_contributor",
} as const

export type FilerClassification = (typeof FilerClassification)[keyof typeof FilerClassification]

/**
 * Map the row's contributor flag and communication-type text to classifications.
 */
export function classifyFiler(row: Form499Row): FilerClassification[] {
	const classifications: FilerClassification[] = []

	if (row.usfContributor) {
		classifications.push(FilerClassification.USFContributor)
	}

	if (row.principalCommType.includes("Incumbent")) {
		classifications.push(FilerClassification.IncumbentLEC)
	} else if (row.principalCommType.includes("CLEC")) {
		classifications.push(FilerClassification.CLEC)
	}

	if (row.principalCommType.includes("Interexchange")) {
		classifications.push(FilerClassification.InterExchange)
	}

	if (row.principalCommType.includes("Toll Reseller")) {
		classifications.push(FilerClassification.TollReseller)
	}

	return classifications
}

/**
 * Map one TSV row to the 17 named fields; throw with path and line number on a column-count mismatch.
 */
function toForm499Raw(fields: readonly string[], tsvPath: string, lineNumber: number): Record<Form499Column, string> {
	if (fields.length !== FORM_499_COLUMNS.length) {
		throw new Error(
			`parseForm499: malformed row at ${tsvPath}:${lineNumber} (line ${lineNumber}) — expected ` +
				`${FORM_499_COLUMNS.length} tab-delimited columns, got ${fields.length}`
		)
	}

	const raw = {} as Record<Form499Column, string>

	FORM_499_COLUMNS.forEach((column, index) => {
		raw[column] = fields[index]!
	})

	return raw
}

/**
 * Convert raw fields to a row, parsing the FRN and contributor flag; retain other fields as strings.
 */
function toForm499Row(raw: Record<Form499Column, string>): Form499Row {
	return {
		form499ID: raw.form499ID,
		frn: toFRN(raw.frn),
		lastFiledAt: raw.lastFiledAt,
		usfContributor: raw.usfContributor.trim() === "TRUE",
		legalNameOfCarrier: raw.legalNameOfCarrier,
		doingBusinessAs: raw.doingBusinessAs,
		principalCommType: raw.principalCommType,
		holdingCompany: raw.holdingCompany,
		managementCompany: raw.managementCompany,
		hqAddress: raw.hqAddress,
		customerInquiriesTelephone: raw.customerInquiriesTelephone,
		customerInquiriesAddress: raw.customerInquiriesAddress,
		dcAgentDisplayName: raw.dcAgentDisplayName,
		dcAgentOrganizationName: raw.dcAgentOrganizationName,
		dcAgentTelephone: raw.dcAgentTelephone,
		dcAgentEmailAddress: raw.dcAgentEmailAddress,
		dcAgentAddress: raw.dcAgentAddress,
	}
}

/**
 * Stream the TSV row by row, rejecting malformed column counts and skipping a blank trailing line.
 */
export async function* parseForm499(tsvPath: PathBuilderLike): AsyncIterable<Form499Row> {
	let lineNumber = 0

	for await (const fields of TSVSpliterator.fromAsync<string[]>(tsvPath, { header: false })) {
		lineNumber++

		if (!fields.length || (fields.length === 1 && !fields[0])) continue

		yield toForm499Row(toForm499Raw(fields, tsvPath.toString(), lineNumber))
	}
}
