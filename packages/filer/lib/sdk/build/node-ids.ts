/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Node identity for `filer.db` — how a source row's identifier becomes a `filer_node.node_id`, and the guards
 *   standing between a malformed row and a degenerate shared node.
 *
 *   Every mint is `${identifierType}:${value}`, so two rows carrying the same identifier land on one node by
 *   construction. That is the dedup mechanism and also what has to be defended: a BLANK value mints one degenerate
 *   node (`frn:`, `form499_id:`) that every other blank-valued row silently collapses into, joining unrelated filers
 *   under a single identity. So the identifier mints throw on a blank rather than accept it; the company-name mints
 *   do not, because each is reached only after its caller has established the name is non-empty.
 *
 *   The two assertions here guard TEMPORAL columns rather than identity: `valid_from` is mandatory on every edge and
 *   every `asOf`-scoped read compares it as a plain string, so a blank value reads as "valid since forever" and a
 *   non-ISO one matches nothing.
 */

import { FilerIdentifierType } from "#schema"
import { assertISODate } from "#sdk/guards"

/**
 * Mints the `frn:` node id, throwing when `frn` is blank — the same "malformed input is loud" discipline as
 * {@linkcode mintForm499NodeID}/{@linkcode mintProviderNodeID}.
 *
 * On the 499 path this is called only from inside the caller's `if (row.frn)` truthy check — an empty string is falsy
 * in JS, so that branch is already skipped before this function is ever reached there; the guard is unreachable on that
 * path, not merely redundant. On the provider-list path `ProviderListRow.frn` is typed as always-present (`FRN`, never
 * `FRN | null`), and {@linkcode parseProviderList} validates it via `toFRN` on the production (file-reading) route — but
 * the `providerRows` TEST INJECTION POINT bypasses that parser entirely. Without this guard, two rows for two
 * DIFFERENT, unrelated providers each carrying a blank `frn` would silently mint and share ONE degenerate `frn:` node —
 * a false identity link joining unrelated filers, the worst failure class this crosswalk can produce.
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

export function mintHoldingCompanyNodeID(name: string): string {
	return `${FilerIdentifierType.HoldingCompanyName}:${name}`
}

export function mintManagementCompanyNodeID(name: string): string {
	return `${FilerIdentifierType.ManagementCompanyName}:${name}`
}

const CIK_SHAPE_PATTERN = /^\d{10}$/

/**
 * Mints the `cik:` node id, throwing when `cik` isn't the zero-padded 10-digit shape `edgar-filings.ts`'s `CIK` branded
 * type requires — the same "malformed input is loud" discipline as {@linkcode mintFRNNodeID}: a malformed CIK would
 * otherwise mint a degenerate/inconsistent node id that could collide with an unrelated row's.
 */
export function mintCIKNodeID(cik: string, context: string): string {
	if (!CIK_SHAPE_PATTERN.test(cik)) {
		throw new Error(
			`buildFilerDatabase: malformed ${context} — cik must be a zero-padded 10-digit string, got ${JSON.stringify(cik)}`
		)
	}

	return `${FilerIdentifierType.CIK}:${cik}`
}

/**
 * Mints the `subsidiary_name:` node id for a raw Exhibit 21 disclosure — the same "global name-node" shape
 * {@linkcode mintHoldingCompanyNodeID} uses (the raw string, unnormalized; two different parents both disclosing a
 * subsidiary under the identical spelling share one node).
 */
export function mintSubsidiaryNameNodeID(name: string): string {
	return `${FilerIdentifierType.SubsidiaryName}:${name}`
}

/**
 * Mints the `form499_id:` node id, throwing when `form499ID` is blank — see `build-filer.ts`'s module docstring,
 * "malformed input is loud" section. An empty string is NOT a legitimate missing value here (unlike a `null` `frn`):
 * every 499 row has SOME `form499ID` in the real file, so a blank one signals a malformed row, and silently minting
 * `form499_id:` would collapse every such row into one degenerate shared node.
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
 * Validates `lastFiledAt` is non-blank before it is written into BOTH `filer_edge.source_vintage`/`valid_from` and
 * every attribute's `source_vintage` for this row. Decision 7 / criterion 1 make `valid_from` MANDATORY on every edge —
 * but `Form499Row.lastFiledAt` is a raw, unvalidated TSV string (`form499.ts`'s own docstring: "no `Date` parsing
 * happens at this layer"), and SQLite's `NOT NULL` does not reject an empty string. An unguarded blank `lastFiledAt`
 * would silently write `source_vintage: ""`/`valid_from: ""` onto every edge/attribute this row produces — a
 * time-scoped read (`valid_from <= asOf`) then treats that edge as valid SINCE FOREVER, exactly the dishonesty decision
 * 7 exists to prevent. Guarded here — in the builder, not in `form499.ts`'s parser — for the same reason
 * {@linkcode mintForm499NodeID} guards `form499ID` here rather than upstream: this file already owns the "which fields
 * are required for THIS artifact's identity/provenance" discipline, and `form499.ts` is deliberately a raw,
 * non-validating passthrough for every field it doesn't itself need to type (see its own docstring).
 */
export function assertLastFiledAt(lastFiledAt: string, form499ID: string, rowIndex: number): string {
	if (lastFiledAt.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed form499 row #${rowIndex} (form499ID=${JSON.stringify(form499ID)}) — empty ` +
				`lastFiledAt. Decision 7 / criterion 1 make valid_from MANDATORY on every edge; a blank value would silently ` +
				`write source_vintage/valid_from as "" on every edge and attribute this row produces, which a ` +
				`time-scoped (valid_from <= asOf) read would then treat as valid since forever.`
		)
	}

	return lastFiledAt
}

/**
 * Requires + ISO-validates {@link BuildFilerOptions.validFrom} — called once, up front, only when a provider-list source
 * is actually supplied. Fails fast, before any file/DB I/O, matching the "pass at least one … source" options-level
 * guard just above it in {@linkcode buildFilerDatabase} — this is the same class of check (an options contract
 * violation, not a malformed data row), so it is validated at the same point in the function, not lazily inside the
 * provider-row loop.
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
 * Mints the `bdc_provider_id:` node id, throwing when `providerID` is not a safe integer — mirrors `peekProviderID`'s
 * `Number.isSafeInteger` guard (`build-bdc.ts`:259). `ProviderListRow.providerID` is already validated by
 * {@linkcode parseProviderList} on the production (file-reading) path, but the `providerRows` TEST INJECTION POINT
 * bypasses that parser entirely — a directly-constructed row with a `NaN` `providerID` would otherwise mint the node id
 * string `"bdc_provider_id:NaN"`, silently merging every malformed row under that one shared identity, the same failure
 * class `build-filer.ts`'s module docstring describes for `form499ID`.
 */
export function mintProviderNodeID(providerID: number, rowIndex: number): string {
	if (!Number.isSafeInteger(providerID)) {
		throw new TypeError(
			`buildFilerDatabase: malformed provider-list row #${rowIndex} — providerID did not parse to a safe ` +
				`integer (got ${JSON.stringify(providerID)}). Refusing to mint a degenerate node_id that every other ` +
				`malformed row would silently collapse into.`
		)
	}

	return `${FilerIdentifierType.BDCProviderID}:${providerID}`
}
