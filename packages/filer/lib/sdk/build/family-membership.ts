/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes the `filer_family` row for each `HoldingCompany` or `ManagementCompany` edge.
 */

import type { StatementSync } from "@mailwoman/sqlite/client"

import { mintFamilyID } from "#sdk/family-id"

/**
 * Inputs for one family row that accompanies an ownership or control edge.
 */
export interface FamilyMembershipFact {
	/**
	 * The edge's source node, stored as `filer_family.node_id`.
	 */
	memberNodeID: string

	/**
	 * The edge's target node, stored as `filer_family.naming_node_id`.
	 */
	namingNodeID: string

	/**
	 * Identifier namespace used to mint the family ID.
	 */
	identifierType: string

	/**
	 * Raw company name used to mint the family ID.
	 */
	name: string

	/**
	 * Relationship copied from the edge.
	 */
	relationship: string

	/**
	 * Assertion copied from the edge.
	 *
	 * The field is required so an inferred claim cannot default to authoritative.
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
 * Writes the family row for an ownership or control edge.
 *
 * Family queries read `filer_family`, so every such edge needs this row.
 * The function writes nothing when the name yields no family ID.
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
