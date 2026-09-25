/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Defines the Form 499 row type and classifications and parses the Form 499 TSV.
 */

import type { PathBuilderLike } from "path-ts"
import { TSVSpliterator } from "spliterator"

import { toFRN, type FRN } from "#frn"
import type { Form499Lifecycle } from "#sdk/form499/notes"

/**
 * The 17 Form 499 TSV columns in file order.
 * The file has no header row.
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

/**
 * Name of one Form 499 TSV column.
 */
export type Form499Column = (typeof FORM_499_COLUMNS)[number]

/**
 * One parsed Form 499 filer row.
 */
export interface Form499Row {
	form499ID: string
	/**
	 * Ten-digit FRN, or `null` when the field is missing or invalid.
	 */
	frn: FRN | null
	/**
	 * Last-filed date exactly as the TSV gives it.
	 * The builder validates it.
	 */
	lastFiledAt: string
	/**
	 * True when the trimmed field equals `"TRUE"`.
	 */
	usfContributor: boolean
	legalNameOfCarrier: string
	doingBusinessAs: string
	/**
	 * Free-text communication type read by {@linkcode classifyFiler}.
	 */
	principalCommType: string
	/**
	 * Owning company.
	 */
	holdingCompany: string
	/**
	 * Company with operational control.
	 */
	managementCompany: string
	hqAddress: string
	customerInquiriesTelephone: string
	customerInquiriesAddress: string
	/**
	 * Registered agent name.
	 *
	 * A shared agent does not link two filers, so the builder stores it only as an attribute.
	 */
	dcAgentDisplayName: string
	dcAgentOrganizationName: string
	dcAgentTelephone: string
	dcAgentEmailAddress: string
	dcAgentAddress: string
	/**
	 * Lifecycle parsed from workbook notes.
	 *
	 * The TSV has no notes, so TSV rows leave this `undefined`.
	 * A workbook row without notes has an empty lifecycle.
	 */
	lifecycle?: Form499Lifecycle
	/**
	 * Sorted USPS codes for the jurisdictions marked in the workbook.
	 *
	 * An empty array means the workbook marked none.
	 * TSV rows leave this `undefined`.
	 */
	operatingStates?: string[]
}

/**
 * Classifications derived from `principalCommType` and `usfContributor`.
 */
export const FilerClassification = {
	IncumbentLEC: "incumbent_lec",
	CLEC: "clec",
	InterExchange: "interexchange",
	TollReseller: "toll_reseller",
	USFContributor: "usf_contributor",
} as const

/**
 * Union of the {@link FilerClassification} values.
 */
export type FilerClassification = (typeof FilerClassification)[keyof typeof FilerClassification]

/**
 * Returns the classifications for a row's contributor flag and communication type.
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
 * Maps one TSV row to the named columns.
 * A row with the wrong column count throws.
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
 * Streams rows from a Form 499 TSV and skips blank lines.
 */
export async function* parseForm499(tsvPath: PathBuilderLike): AsyncIterable<Form499Row> {
	let lineNumber = 0

	for await (const fields of TSVSpliterator.fromAsync<string[]>(tsvPath, { header: false })) {
		lineNumber++

		if (!fields.length || (fields.length === 1 && !fields[0])) continue

		yield toForm499Row(toForm499Raw(fields, tsvPath.toString(), lineNumber))
	}
}
