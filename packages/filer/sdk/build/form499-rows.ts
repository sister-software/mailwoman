/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One Form 499 row's lifecycle, edge and family membership writes.
 *
 *   Form 499 is an ANNUAL filing, so a row's administrative `lastFiledAt` and the FCC's operational `ceasedAt` are two
 *   different clocks and nothing orders them. {@linkcode closeableCessationDate} is where that is resolved, and its
 *   abstention is why `valid_to` is sometimes left open on a filer known to have ceased.
 */

import type { StatementSync } from "@mailwoman/sqlite/client"

import { FilerEdgeAssertion, FilerIdentifierType, FilerRelationship } from "#schema"
import { insertFamilyMembership } from "#sdk/build/family-membership"
import { mintFRNNodeID, mintHoldingCompanyNodeID, mintManagementCompanyNodeID } from "#sdk/build/node-ids"
import type { Form499Row } from "#sdk/form499"
import type { Form499Lifecycle } from "#sdk/form499-notes"

/**
 * The cessation date to close a relationship window at, or `null` when closing it would assert something incoherent.
 *
 * **Two clocks, and they disagree on 40% of ceased filers.** Form 499 is an ANNUAL filing, so a carrier that ceased
 * operating on 2013-09-08 still files the form on 2014-04-01. `lastFiledAt` is an administrative date; `ceasedAt` is an
 * operational one, and nothing makes the second later than the first. Measured on the 2025-12-07 vintage: of 9,706
 * dated cessations, 5,714 postdate the last filing, **3,916 predate it**, and 76 fall on the same day.
 *
 * Writing `valid_to = ceasedAt` unconditionally against `valid_from = lastFiledAt` would produce an inverted or empty
 * window on those 3,992 — and the half-open predicate `valid_from <= t < valid_to` matches NOTHING across one. Every
 * affected filer would vanish from every `asOf` read, silently, with no error and no missing row to notice. That is
 * strictly worse than leaving the window open, which is at least visibly incomplete.
 *
 * So: close the window only when the two dates order coherently, and count the abstentions
 * ({@link BuildFilerResult.cessationWindowAbstained}). The date itself is never lost — it is staged as a `ceased_at`
 * attribute on every ceased filer regardless.
 */
export function closeableCessationDate(ceasedAt: string | undefined, validFrom: string): string | null {
	if (!ceasedAt) return null

	return ceasedAt > validFrom ? ceasedAt : null
}

/**
 * {@linkcode processForm499Lifecycle}'s per-row context.
 */
export interface Form499LifecycleContext {
	lifecycle: Form499Lifecycle | undefined
	form499NodeID: string
	lastFiledAt: string
}

/**
 * Running totals across every row's lifecycle writes, mutated in place by {@linkcode processForm499Lifecycle} and read
 * once into {@link BuildFilerResult}. One accumulator object rather than three `let`s at the call site: this loop body
 * sits against the linter's `max-statements` ceiling, which is also why the helper exists at all.
 */
export interface Form499LifecycleTotals {
	closed: number
	abstained: number
	supersessions: number
}

/**
 * One 499 row's lifecycle writes: a `ceased_at` attribute, one `cessation_reason` attribute per recognized reason, and
 * a `SupersededBy` edge when the FCC named a successor filer. Returns the `valid_to` the caller should stamp on that
 * row's relationship edges — see {@linkcode closeableCessationDate} for when that is `null` and why.
 *
 * Its own function for the same reason {@linkcode processForm499FRNRelationships} is: inlined into the 499 loop, it
 * pushes `buildFilerDatabase` past the linter's `max-statements` ceiling.
 *
 * A row whose `lifecycle` is `undefined` (every row the 17-column TSV parser produces) writes nothing, touches no total
 * and returns `null` — the TSV path is byte-identical to what it was before this existed.
 */
export function processForm499Lifecycle(
	insNode: StatementSync,
	insEdge: StatementSync,
	stageAttribute: (nodeID: string, key: string, value: string, source: string, sourceVintage: string) => void,
	totals: Form499LifecycleTotals,
	context: Form499LifecycleContext
): string | null {
	const { lifecycle, form499NodeID, lastFiledAt } = context
	const ceasedAt = lifecycle?.ceasedAt
	const relationshipValidTo = closeableCessationDate(ceasedAt, lastFiledAt)

	if (ceasedAt) {
		// Recorded unconditionally, including where the window abstains — the date is a fact the FCC stated,
		// and losing it because the two clocks disagree would be the worse trade.
		stageAttribute(form499NodeID, "ceased_at", ceasedAt, "form-499", lastFiledAt)

		if (relationshipValidTo) {
			totals.closed++
		} else {
			totals.abstained++
		}
	}

	for (const reason of lifecycle?.reasons ?? []) {
		stageAttribute(form499NodeID, "cessation_reason", reason, "form-499", lastFiledAt)
	}

	if (lifecycle?.replacedByForm499ID) {
		// Directional in TIME as well as identity: this registration is the OLDER one, always. The successor's
		// node is minted here rather than waited for — it is almost always its own row in the same file, but
		// nothing guarantees this row is processed second, and `insNode` is INSERT OR IGNORE.
		const successorNodeID = `${FilerIdentifierType.Form499ID}:${lifecycle.replacedByForm499ID}`
		insNode.run(successorNodeID, FilerIdentifierType.Form499ID, lifecycle.replacedByForm499ID)

		insEdge.run(
			form499NodeID,
			successorNodeID,
			FilerEdgeAssertion.Authoritative,
			FilerRelationship.SupersededBy,
			"form-499",
			lastFiledAt,
			// The supersession takes effect when the filer ceased, when the FCC said so. Falling back to the
			// filing date keeps `valid_from` mandatory (decision 7) without inventing a date.
			ceasedAt ?? lastFiledAt,
			null,
			null,
			null
		)

		totals.supersessions++
	}

	return relationshipValidTo
}

/**
 * {@linkcode processForm499FRNRelationships}'s per-row context — bundled into one options argument (matching
 * {@linkcode FamilyMembershipFact}'s own precedent) once threading `legalNameByFRN` through pushed this function's
 * positional arity past the linter's `max-params` ceiling.
 */
export interface Form499FRNContext {
	row: Form499Row
	frn: string
	form499NodeID: string
	form499RowIndex: number
	lastFiledAt: string
	/**
	 * `valid_to` for this row's RELATIONSHIP edges, or `null` — see {@linkcode closeableCessationDate}. Deliberately not
	 * applied to the `FRN↔form499ID` identity edge below: that edge asserts the two identifiers denote the same filer,
	 * which does not stop being true when the company does. Only assertions that can expire get closed.
	 */
	relationshipValidTo: string | null
}

/**
 * One 499 row's FRN-anchored writes: `FRN↔form499ID` (always), `FRN↔holdingCompanyName`/`FRN↔managementCompanyName`
 * (when the corresponding field is non-empty, each its own edge + `filer_family` row) — see `build-filer.ts`'s module
 * docstring, "Edges emitted" section. Also records this row's legal name into `legalNameByFRN` for
 * {@linkcode processEdgarSubsidiaryRow}'s corroboration match, keeping the LATEST `lastFiledAt` per FRN. Returns the
 * number of edge OPPORTUNITIES declined (0, 1, or 2 — see `BuildFilerResult.skipped`'s docstring), for the caller to
 * add to its own running total. Its own function so the 499 loop stays under the linter's `max-statements` ceiling.
 */
export function processForm499FRNRelationships(
	insNode: StatementSync,
	insEdge: StatementSync,
	insFamily: StatementSync,
	legalNameByFRN: Map<string, { name: string; filedAt: string }>,
	context: Form499FRNContext
): number {
	const { row, frn, form499NodeID, form499RowIndex, lastFiledAt, relationshipValidTo } = context
	const frnContext = `form499 row #${form499RowIndex} (form499ID=${JSON.stringify(row.form499ID)})`
	const frnNodeID = mintFRNNodeID(frn, frnContext)
	insNode.run(frnNodeID, FilerIdentifierType.FRN, frn)

	if (row.legalNameOfCarrier) {
		const current = legalNameByFRN.get(frn)

		if (!current || lastFiledAt > current.filedAt) {
			legalNameByFRN.set(frn, { name: row.legalNameOfCarrier, filedAt: lastFiledAt })
		}
	}

	insEdge.run(
		frnNodeID,
		form499NodeID,
		FilerEdgeAssertion.Authoritative,
		FilerRelationship.SameEntity,
		"form-499",
		lastFiledAt,
		lastFiledAt,
		null,
		null,
		null
	)

	let skipped = 0

	if (row.holdingCompany) {
		const holdingNodeID = mintHoldingCompanyNodeID(row.holdingCompany)
		insNode.run(holdingNodeID, FilerIdentifierType.HoldingCompanyName, row.holdingCompany)

		insEdge.run(
			frnNodeID,
			holdingNodeID,
			FilerEdgeAssertion.Authoritative,
			FilerRelationship.HoldingCompany,
			"form-499",
			lastFiledAt,
			lastFiledAt,
			relationshipValidTo,
			null,
			null
		)

		insertFamilyMembership(insFamily, {
			memberNodeID: frnNodeID,
			namingNodeID: holdingNodeID,
			identifierType: FilerIdentifierType.HoldingCompanyName,
			name: row.holdingCompany,
			relationship: FilerRelationship.HoldingCompany,
			assertion: FilerEdgeAssertion.Authoritative,
			matchScore: null,
			source: "form-499",
			sourceVintage: lastFiledAt,
			validFrom: lastFiledAt,
		})
	} else {
		skipped++
	}

	if (row.managementCompany) {
		const managementNodeID = mintManagementCompanyNodeID(row.managementCompany)
		insNode.run(managementNodeID, FilerIdentifierType.ManagementCompanyName, row.managementCompany)

		insEdge.run(
			frnNodeID,
			managementNodeID,
			FilerEdgeAssertion.Authoritative,
			FilerRelationship.ManagementCompany,
			"form-499",
			lastFiledAt,
			lastFiledAt,
			relationshipValidTo,
			null,
			null
		)

		insertFamilyMembership(insFamily, {
			memberNodeID: frnNodeID,
			namingNodeID: managementNodeID,
			identifierType: FilerIdentifierType.ManagementCompanyName,
			name: row.managementCompany,
			relationship: FilerRelationship.ManagementCompany,
			assertion: FilerEdgeAssertion.Authoritative,
			matchScore: null,
			source: "form-499",
			sourceVintage: lastFiledAt,
			validFrom: lastFiledAt,
		})
	} else {
		skipped++
	}

	return skipped
}
