/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Write the `filer_family` membership accompanying each `HoldingCompany` or `ManagementCompany` edge.
 *   Family queries read `filer_family`, so callers must persist both the edge and its membership row.
 */

import type { StatementSync } from "@mailwoman/sqlite/client"

import { mintFamilyID } from "#sdk/family-id"

// Share family-ID canonicalization with family display-name lookup.

/**
 * Inputs used to write one family row alongside its ownership or control edge.
 */
export interface FamilyMembershipFact {
	/**
	 * Edge source node; becomes `filer_family.node_id`.
	 */
	memberNodeID: string

	/**
	 * Edge target node; becomes `filer_family.naming_node_id`.
	 */
	namingNodeID: string

	/**
	 * Identifier namespace used to mint the family ID.
	 */
	identifierType: string

	/**
	 * Raw company name used to mint the family ID; its spelling remains on the naming node.
	 */
	name: string

	/**
	 * Relationship copied from the accompanying edge.
	 */
	relationship: string

	/**
	 * Assertion copied from the edge.
	 *
	 * Required to prevent inferred claims defaulting to authoritative.
	 */
	assertion: string

	/**
	 * Inference score, or `null` for authoritative membership.
	 */
	matchScore: number | null
	source: string
	sourceVintage: string
	validFrom: string
}

/**
 * Write the family row for an ownership or control edge.
 *
 * If the target name has no family ID, write nothing.
 * Reuse the caller's prepared statement and target node ID so the membership
 * and edge refer to the same entity.
 *
 * Persisting the naming node also lets readers recover its raw name by joining,
 * without re-canonicalizing it.
 */
export function insertFamilyMembership(insFamily: StatementSync, fact: FamilyMembershipFact): void {
	const familyID = mintFamilyID(fact.identifierType, fact.name)

	if (!familyID) return

	insFamily.run(
		fact.memberNodeID,
		familyID,
		fact.namingNodeID,
		fact.assertion,
		fact.relationship,
		fact.source,
		fact.sourceVintage,
		fact.validFrom,
		null,
		fact.matchScore
	)
}
