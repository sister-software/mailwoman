/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Stream the BDC provider list by header name, requiring `frn`, `provider_id`, and `holding_company`.
 *   Preserve every row in file order, including repeated provider IDs. Throw on malformed headers, column counts,
 *   provider IDs, or FRNs; the FRN is a required zero-padded 10-digit string.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

import { toFRN, type FRN } from "#frn"

/**
 * Required columns, located by header name so other columns may be reordered or added.
 */
const REQUIRED_PROVIDER_LIST_COLUMNS = ["frn", "provider_id", "holding_company"] as const satisfies readonly string[]

/**
 * One parsed provider-list row.
 */
export interface ProviderListRow {
	/**
	 * Numeric FCC provider identifier.
	 */
	providerID: number
	/**
	 * Required zero-padded 10-digit FRN.
	 */
	frn: FRN
	/**
	 * Holding-company name from this row, or `null` when empty.
	 * It may vary across rows for one provider ID.
	 */
	holdingCompany: string | null
}

/**
 * Require all mandatory columns and identify any missing column in the error.
 */
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
 * Convert a validated row to its typed form; include file and line details for invalid identifiers.
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
 * Stream the CSV with quote-aware parsing.
 *
 * Use the first non-blank row as the header, skip blank rows, and reject mismatched column counts.
 * Yield every data row in file order without deduplicating provider IDs.
 */
export async function* parseProviderList(source: PathBuilderLike): AsyncIterable<ProviderListRow> {
	// Include the source path in parse errors.
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
