/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Node identity for `filer.db` — how a source row's identifier becomes a `filer_node.node_id`, and the guards
 *   standing between a malformed row and a degenerate shared node.
 *
 *   Every mint is `${identifierType}:${value}`, so a blank identifier mints one degenerate node that every other
 *   blank-valued row collapses into; the identifier mints therefore throw, while the company-name mints rely on callers
 *   having established non-emptiness, and the two assertions guard temporal columns, where a blank `valid_from` reads
 *   as valid since forever and a non-ISO one matches no row.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { FilerIdentifierType } from "#schema"
import { assertISODate } from "#sdk/guards"

/**
 * Mints the `frn:` node id, throwing when `frn` is blank; the `providerRows` injection
 * point bypasses {@linkcode parseProviderList}, so a blank `frn` would otherwise
 * mint a degenerate `frn:` node shared by unrelated providers.
 */
export function mintFRNNodeID(frn: string, context: string): string {
	if (frn.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed ${context} — empty frn. Refusing to mint a degenerate node_id ("frn:") ` +
				`that every other empty-frn row would silently collapse into, falsely joining unrelated filers under one identity.`
		)
	}

	return `${FilerIdentifierType.FRN}:${frn}`
}

/**
 * Mints the `holding_company_name:` node id from the raw, unnormalized name,
 * so identical spellings share one node.
 */
export function mintHoldingCompanyNodeID(name: string): string {
	return `${FilerIdentifierType.HoldingCompanyName}:${name}`
}

/**
 * Mints the `management_company_name:` node id from the raw, unnormalized name,
 * so identical spellings share one node.
 */
export function mintManagementCompanyNodeID(name: string): string {
	return `${FilerIdentifierType.ManagementCompanyName}:${name}`
}

const CIK_SHAPE_PATTERN = /^\d{10}$/

/**
 * Mints the `cik:` node id, throwing when `cik` isn't the zero-padded 10-digit
 * shape the `CIK` branded type requires.
 */
export function mintCIKNodeID(cik: string, context: string): string {
	if (!CIK_SHAPE_PATTERN.test(cik)) {
		throw new Error(
			`buildFilerDatabase: malformed ${context} — cik must be a zero-padded 10-digit string, got ${stringifyJSON(cik)}`
		)
	}

	return `${FilerIdentifierType.CIK}:${cik}`
}

/**
 * Mints the `subsidiary_name:` node id for a raw Exhibit 21 disclosure, so two different
 * parents both disclosing a subsidiary under the identical spelling share one node.
 */
export function mintSubsidiaryNameNodeID(name: string): string {
	return `${FilerIdentifierType.SubsidiaryName}:${name}`
}

/**
 * Mints the `form499_id:` node id, throwing when `form499ID` is blank;
 * every real 499 row has a `form499ID`, so a blank one signals a malformed row that
 * would otherwise collapse into one degenerate shared node.
 */
export function mintForm499NodeID(form499ID: string, rowIndex: number): string {
	if (form499ID.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed form499 row #${rowIndex} — empty form499ID. Refusing to mint a ` +
				`degenerate node_id ("form499_id:") that every other empty-form499ID row would silently collapse ` +
				`into, merging unrelated filers under one shared identity.`
		)
	}

	return `${FilerIdentifierType.Form499ID}:${form499ID}`
}

/**
 * Validates `lastFiledAt` is non-blank before it is written into both
 * `filer_edge.source_vintage`/`valid_from` and every attribute's `source_vintage` for this row;
 * it is a raw, unvalidated TSV string, and SQLite's `not NULL` does not reject an empty string,
 * which a `valid_from <= asOf` read would treat as valid since forever.
 */
export function assertLastFiledAt(lastFiledAt: string, form499ID: string, rowIndex: number): string {
	if (lastFiledAt.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed form499 row #${rowIndex} (form499ID=${stringifyJSON(form499ID)}) — empty ` +
				`lastFiledAt. Decision 7 / criterion 1 make valid_from MANDATORY on every edge; a blank value would silently ` +
				`write source_vintage/valid_from as "" on every edge and attribute this row produces, which a ` +
				`time-scoped (valid_from <= asOf) read would then treat as valid since forever.`
		)
	}

	return lastFiledAt
}

/**
 * Requires and ISO-validates {@link BuildFilerOptions.validFrom} up front when a
 * provider-list source is supplied, failing fast before any file or database I/O.
 */
export function assertProviderValidFrom(validFrom: string | undefined): string {
	if (validFrom === undefined) {
		throw new Error(
			"buildFilerDatabase: options.validFrom is required when a provider-list source (providerRows/" +
				"providerListPath) is supplied — provider-list edges need an ISO YYYY-MM-DD valid_from that is " +
				'SEPARATE from sourceVintage (which may stay a human vintage label like "2026-Q2"); see ' +
				"BuildFilerOptions.validFrom's docstring for why the two must never be the same field."
		)
	}

	return assertISODate(validFrom, "options.validFrom")
}

/**
 * Mints the `bdc_provider_id:` node id, throwing when `providerID` is not a safe integer;
 * the `providerRows` injection point bypasses {@linkcode parseProviderList}, so a `NaN` would
 * otherwise mint `"bdc_provider_id:NaN"` and merge every malformed row under that identity.
 */
export function mintProviderNodeID(providerID: number, rowIndex: number): string {
	if (!Number.isSafeInteger(providerID)) {
		throw new TypeError(
			`buildFilerDatabase: malformed provider-list row #${rowIndex} — providerID did not parse to a safe ` +
				`integer (got ${stringifyJSON(providerID)}). Refusing to mint a degenerate node_id that every other ` +
				`malformed row would silently collapse into.`
		)
	}

	return `${FilerIdentifierType.BDCProviderID}:${providerID}`
}
