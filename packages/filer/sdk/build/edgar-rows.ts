/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One EDGAR Exhibit 21 subsidiary disclosure, and the two edges it can produce.
 *
 *   The two edges answer different questions and carry different strengths. The DISCLOSURE edge (`cik ->
 *   subsidiaryName`) is always written and always authoritative: Exhibit 21 is the filer's own filed statement that a
 *   subsidiary by this name exists, which holds whether or not anything here can work out WHICH registrant it
 *   corresponds to. The CORROBORATION edge (`frn -> cik`) is an INFERENCE — which FRN a disclosed name actually is
 *   is not in Exhibit 21 at all — so it is written only when exactly one FRN's legal name canonically matches, and it
 *   carries a {@linkcode scoreEdgarSubsidiaryMatch} score rather than authority.
 *
 *   See `build-filer.ts`'s module docstring for the full rationale, including why a name collision abstains rather
 *   than picking, and why the corroboration must also land in `filer_family`.
 */

import type { StatementSync } from "node:sqlite"

import { canonicalizeOrganizationName } from "@mailwoman/record"

import { FilerEdgeAssertion, FilerIdentifierType, FilerRelationship } from "../../schema.ts"
import { assertISODate } from "../guards.ts"
import { scoreEdgarSubsidiaryMatch, type CanonicalNameCandidate } from "./edgar-match.ts"
import { mintCIKNodeID, mintFRNNodeID, mintSubsidiaryNameNodeID } from "./node-ids.ts"

/**
 * One EDGAR Exhibit 21 subsidiary disclosure — the shape upstream CIK resolution + `parseExhibit21` produce somewhere
 * outside this file. See `build-filer.ts`'s module docstring, "EDGAR Exhibit 21 ingest" section, for exactly what
 * {@linkcode buildFilerDatabase} does with one of these.
 */
export interface EdgarSubsidiaryRow {
	/**
	 * Zero-padded 10-digit CIK of the filer whose Exhibit 21 disclosed this subsidiary — the PARENT. Validated the same
	 * zero-padded 10-digit shape `edgar-filings.ts`'s `CIK` branded type requires; a malformed value throws (decision 8's
	 * "malformed input is loud" discipline).
	 */
	cik: string
	/**
	 * The subsidiary's name exactly as Exhibit 21 spelled it — never normalized before minting its node (mirrors
	 * `mintHoldingCompanyNodeID`'s identical "raw string" precedent).
	 */
	subsidiaryName: string
	/**
	 * Jurisdiction of incorporation, when Exhibit 21 gave one ({@linkcode parseExhibit21}'s own `unparseable` abstention
	 * already dropped any row this couldn't confidently extract — this field is carried through for provenance/audit
	 * only; nothing in this builder currently writes it to a column).
	 */
	jurisdiction?: string
	/**
	 * ISO `YYYY-MM-DD` filing date of the 10-K this Exhibit 21 came from — becomes BOTH `source_vintage` and `valid_from`
	 * on every edge/family row this row produces (decision 7 — a single per-row date, the same shape
	 * `Form499Row.lastFiledAt` uses). Validated via {@linkcode assertISODate}.
	 */
	filingDate: string
}

/**
 * One EDGAR subsidiary row's full write: the disclosure edge (always, authoritative) plus — only when the subsidiary
 * name canonically matches EXACTLY ONE FRN's legal name — the corroboration edge and its accompanying `filer_family`
 * row (inference, never authority; see `build-filer.ts`'s module docstring, "EDGAR Exhibit 21 ingest" section, for the
 * full rationale and the family-visibility precondition this is written to satisfy).
 */
export function processEdgarSubsidiaryRow(
	insNode: StatementSync,
	insEdge: StatementSync,
	insFamily: StatementSync,
	frnsByCanonicalLegalName: ReadonlyMap<string, CanonicalNameCandidate[]>,
	row: EdgarSubsidiaryRow,
	rowIndex: number
): void {
	const context = `edgar row #${rowIndex} (cik=${JSON.stringify(row.cik)})`
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

	// The disclosure edge — ALWAYS written, ALWAYS authoritative. See this module's file header.
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

	// Corroboration — INFERENCE, not authority, and only when UNAMBIGUOUS (exactly one match). Zero matches: nothing
	// more to write, the disclosure edge above is the whole fact. Two or more: a genuine name collision across
	// distinct FRNs — abstain rather than guess which one, same as resolveCIKCandidates never silently narrowing a
	// tie. Grading the survivors is not a substitute for abstaining on a
	// tie, and the two answer different questions (WHETHER to write an edge vs how far to trust the one written).
	if (matchedFRNs.length !== 1) return

	const matched = matchedFRNs[0]!
	const matchedFRNNodeID = mintFRNNodeID(matched.frn, context)
	insNode.run(matchedFRNNodeID, FilerIdentifierType.FRN, matched.frn)

	// the score reflects what THIS match actually knows, not a flat 0.92 on every link — see
	// scoreEdgarSubsidiaryMatch. `evidence` carries both raw spellings now, so a reader can see for itself what the
	// score is grading rather than having to take the number on faith.
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
		JSON.stringify({ subsidiaryName: row.subsidiaryName, legalNameOfCarrier: matched.legalName, cik: row.cik })
	)

	// The family-visibility precondition: a filer_edge row ALONE is invisible to familyRollup/filerLookup.families — both
	// answer membership from filer_family alone. family_id/naming_node_id are the CIK's OWN node id: a CIK needs no
	// mintFamilyID canonicalization to be a stable family key, unlike a free-text holding-/management-company name.
	//
	// assertion/match_score carry the SAME values as the edge above, for the same reason the row exists
	// at all: a reader answering a family question from this table alone must be able to tell this name-match
	// inference from a holding-company membership the filer itself filed.
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
