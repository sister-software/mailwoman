/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Parses the BDC provider-list CSV.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { toFRN, type FRN } from "#frn"

/**
 * Required columns.
 *
 * The parser finds them by header name, so their order does not matter.
 */
const REQUIRED_PROVIDER_LIST_COLUMNS = ["frn", "provider_id", "holding_company"] as const satisfies readonly string[]

/**
 * One parsed provider-list row.
 */
export interface ProviderListRow {
	providerID: number
	/**
	 * Zero-padded 10-digit FRN.
	 */
	frn: FRN
	/**
	 * Holding-company name, or `null` when empty.
	 *
	 * Rows for the same provider ID can carry different names.
	 */
	holdingCompany: string | null
}

function assertRequiredProviderListColumns(header: readonly string[], csvPath: string): void {
	for (const column of REQUIRED_PROVIDER_LIST_COLUMNS) {
		if (!header.includes(column)) {
			throw new Error(
				`parseProviderList: malformed header at ${csvPath} — missing required column ${stringifyJSON(column)}`
			)
		}
	}
}

/**
 * Converts one CSV row to a typed row.
 * An invalid provider ID or FRN throws.
 */
function toProviderListRow(
	header: readonly string[],
	fields: readonly string[],
	csvPath: string,
	lineNumber: number
): ProviderListRow {
	const raw: Record<string, string> = {}

	header.forEach((column, index) => {
		raw[column] = fields[index]!
	})

	const providerIDField = raw.provider_id!
	const providerID = Number.parseInt(providerIDField, 10)

	if (!Number.isSafeInteger(providerID)) {
		throw new TypeError(
			`parseProviderList: malformed row at ${csvPath}:${lineNumber} (line ${lineNumber}) — provider_id did not ` +
				`parse to a safe integer, got ${stringifyJSON(providerIDField)}`
		)
	}

	const frn = toFRN(raw.frn!)

	if (frn === null) {
		throw new Error(
			`parseProviderList: malformed row at ${csvPath}:${lineNumber} (line ${lineNumber}) — frn ` +
				`${stringifyJSON(raw.frn)} did not parse to a valid FRN`
		)
	}

	const holdingCompanyField = raw.holding_company!

	return {
		providerID,
		frn,
		holdingCompany: holdingCompanyField === "" ? null : holdingCompanyField,
	}
}

/**
 * Streams rows from a BDC provider-list CSV.
 *
 * The first non-blank row is the header.
 * The parser skips blank rows and throws on a row whose column count differs from the header.
 *
 * It yields every row in file order, including repeated provider IDs.
 */
export async function* parseProviderList(source: PathBuilderLike): AsyncIterable<ProviderListRow> {
	const csvPath = source.toString()
	let lineNumber = 0
	let header: string[] | null = null

	for await (const fields of CSVSpliterator.fromAsync<string[]>(source, { header: false })) {
		lineNumber++

		if (!fields.length || (fields.length === 1 && !fields[0])) continue

		if (header === null) {
			assertRequiredProviderListColumns(fields, csvPath)
			header = fields

			continue
		}

		if (fields.length !== header.length) {
			throw new Error(
				`parseProviderList: malformed row at ${csvPath}:${lineNumber} (line ${lineNumber}) — expected ` +
					`${header.length} comma-delimited columns (per header), got ${fields.length}`
			)
		}

		yield toProviderListRow(header, fields, csvPath, lineNumber)
	}
}
