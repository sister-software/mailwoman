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
	memberNodeID: string

	namingNodeID: string

	identifierType: string

	name: string

	relationship: string

	/**
	 * Required so an inferred claim cannot default to authoritative.
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
 * Writes the family row for an ownership or control edge, which family queries need
 * because they read `filer_family`.
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
