/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One edgar Exhibit 21 subsidiary disclosure, and the two edges it can produce.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { canonicalizeOrganizationName } from "@mailwoman/record"
import type { StatementSync } from "@mailwoman/sqlite/client"

import { FilerEdgeAssertion, FilerIdentifierType, FilerRelationship } from "#schema"
import { scoreEdgarSubsidiaryMatch, type CanonicalNameCandidate } from "#sdk/build/edgar/match"
import { mintCIKNodeID, mintFRNNodeID, mintSubsidiaryNameNodeID } from "#sdk/build/node-ids"
import { assertISODate } from "#sdk/guards"

/**
 * One edgar Exhibit 21 subsidiary disclosure, as produced by upstream CIK resolution and `parseExhibit21`.
 */
export interface EdgarSubsidiaryRow {
	/**
	 * Zero-padded 10-digit CIK of the parent filer; a malformed value throws.
	 */
	cik: string
	/**
	 * The subsidiary's name exactly as Exhibit 21 spelled it, never normalized before minting its node.
	 */
	subsidiaryName: string
	/**
	 * Jurisdiction of incorporation for provenance only; no code in this builder writes it to a column.
	 */
	jurisdiction?: string
	/**
	 * ISO `yyyy-MM-DD` filing date of the 10-K this Exhibit 21 came from; validated by
	 * {@linkcode assertISODate} and becomes both `source_vintage` and `valid_from` on every row it produces.
	 */
	filingDate: string
}

/**
 * Writes one edgar subsidiary row: the authoritative disclosure edge, plus the
 * inferred corroboration edge and its `filer_family` row only when the subsidiary
 * name canonically matches exactly one FRN's legal name.
 */
export function processEdgarSubsidiaryRow(
	insNode: StatementSync,
	insEdge: StatementSync,
	insFamily: StatementSync,
	frnsByCanonicalLegalName: ReadonlyMap<string, CanonicalNameCandidate[]>,
	row: EdgarSubsidiaryRow,
	rowIndex: number
): void {
	const context = `edgar row #${rowIndex} (cik=${stringifyJSON(row.cik)})`
	const cikNodeID = mintCIKNodeID(row.cik, context)
	insNode.run(cikNodeID, FilerIdentifierType.CIK, row.cik)

	if (row.subsidiaryName.trim() === "") {
		throw new Error(
			`buildFilerDatabase: malformed ${context} — empty subsidiaryName. Refusing to mint a degenerate node_id ` +
				`("subsidiary_name:") that every other empty-name row would silently collapse into.`
		)
	}

	const filingDate = assertISODate(row.filingDate, `${context} filingDate`)
	const subsidiaryNodeID = mintSubsidiaryNameNodeID(row.subsidiaryName)
	insNode.run(subsidiaryNodeID, FilerIdentifierType.SubsidiaryName, row.subsidiaryName)

	insEdge.run(
		cikNodeID,
		subsidiaryNodeID,
		FilerEdgeAssertion.Authoritative,
		FilerRelationship.Subsidiary,
		"edgar-exhibit-21",
		filingDate,
		filingDate,
		null,
		null,
		null
	)

	const canonicalSubsidiaryName = canonicalizeOrganizationName(row.subsidiaryName)?.canonical
	const matchedFRNs = canonicalSubsidiaryName ? (frnsByCanonicalLegalName.get(canonicalSubsidiaryName) ?? []) : []

	// A collision across distinct FRNs abstains rather than guessing.
	if (matchedFRNs.length !== 1) return

	const matched = matchedFRNs[0]!
	const matchedFRNNodeID = mintFRNNodeID(matched.frn, context)
	insNode.run(matchedFRNNodeID, FilerIdentifierType.FRN, matched.frn)

	const matchScore = scoreEdgarSubsidiaryMatch(row.subsidiaryName, matched.legalName)

	insEdge.run(
		matchedFRNNodeID,
		cikNodeID,
		FilerEdgeAssertion.Inferred,
		FilerRelationship.ParentCompany,
		"edgar-exhibit-21",
		filingDate,
		filingDate,
		null,
		matchScore,
		stringifyJSON({ subsidiaryName: row.subsidiaryName, legalNameOfCarrier: matched.legalName, cik: row.cik })
	)

	// A `filer_edge` row alone is invisible to `familyRollup`/`filerLookup.families`,
	// which answer membership from `filer_family` alone.
	insFamily.run(
		matchedFRNNodeID,
		cikNodeID,
		cikNodeID,
		FilerEdgeAssertion.Inferred,
		FilerRelationship.ParentCompany,
		"edgar-exhibit-21",
		filingDate,
		filingDate,
		null,
		matchScore
	)
}
