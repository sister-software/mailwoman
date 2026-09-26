/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One Form 499 row's lifecycle, edge and family membership writes.
 *
 *   Form 499 is an annual filing, so a row's administrative `lastFiledAt` and the FCC's operational `ceasedAt` are two
 *   different clocks that no field orders; {@linkcode closeableCessationDate} resolves that, and its abstention is why
 *   `valid_to` is sometimes left open on a filer known to have ceased.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import type { StatementSync } from "@mailwoman/sqlite/client"

import { FilerEdgeAssertion, FilerIdentifierType, FilerRelationship } from "#schema"
import { insertFamilyMembership } from "#sdk/build/family-membership"
import { mintFRNNodeID, mintHoldingCompanyNodeID, mintManagementCompanyNodeID } from "#sdk/build/node-ids"
import type { Form499Row } from "#sdk/form499/index"
import type { Form499Lifecycle } from "#sdk/form499/notes"

/**
 * The cessation date to close a relationship window at, or `null` when closing it would
 * invert the interval (`valid_from <= t < valid_to`) and make the filer disappear
 * from `asOf` reads; callers still record the date as `ceased_at`.
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
 * Running totals across every row's lifecycle writes, mutated in place by
 * {@linkcode processForm499Lifecycle} and read once into {@link BuildFilerResult}.
 */
export interface Form499LifecycleTotals {
	closed: number
	abstained: number
	supersessions: number
}

/**
 * One 499 row's lifecycle writes: a `ceased_at` attribute, one `cessation_reason` attribute
 * per recognized reason, and a `SupersededBy` edge when the FCC named a successor filer.
 *
 * Returns the `valid_to` the caller should stamp on that row's relationship edges,
 * or `null` when {@linkcode closeableCessationDate} abstains.
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
		// Recorded unconditionally, including where the window abstains, because the date is a fact the FCC stated.
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
		// The successor's node is minted here, not waited for: its own row is usually in the same file,
		// but no ordering guarantees this row is processed first and `insNode` is insert or ignore.
		const successorNodeID = `${FilerIdentifierType.Form499ID}:${lifecycle.replacedByForm499ID}`
		insNode.run(successorNodeID, FilerIdentifierType.Form499ID, lifecycle.replacedByForm499ID)

		insEdge.run(
			form499NodeID,
			successorNodeID,
			FilerEdgeAssertion.Authoritative,
			FilerRelationship.SupersededBy,
			"form-499",
			lastFiledAt,
			// The supersession takes effect when the filer ceased, falling back to the
			// filing date because `valid_from` is mandatory.
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
 * {@linkcode processForm499FRNRelationships}'s per-row context, bundled into one options argument.
 */
export interface Form499FRNContext {
	row: Form499Row
	frn: string
	form499NodeID: string
	form499RowIndex: number
	lastFiledAt: string
	/**
	 * `valid_to` for this row's expiring relationship edges only; the `FRN↔form499ID` identity
	 * edge remains valid for the company's lifetime because the identifiers denote one filer.
	 */
	relationshipValidTo: string | null
}

/**
 * One 499 row's FRN-anchored writes: `FRN↔form499ID` (always), and the holding/management-company
 * edges when the corresponding field is non-empty (each its own edge and `filer_family` row).
 *
 * Also records this row's legal name into `legalNameByFRN` for {@linkcode processEdgarSubsidiaryRow}'s
 * corroboration match, keeping the latest `lastFiledAt` per FRN; returns the
 * number of edge opportunities declined (0, 1, or 2).
 */
export function processForm499FRNRelationships(
	insNode: StatementSync,
	insEdge: StatementSync,
	insFamily: StatementSync,
	legalNameByFRN: Map<string, { name: string; filedAt: string }>,
	context: Form499FRNContext
): number {
	const { row, frn, form499NodeID, form499RowIndex, lastFiledAt, relationshipValidTo } = context
	const frnContext = `form499 row #${form499RowIndex} (form499ID=${stringifyJSON(row.form499ID)})`
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
