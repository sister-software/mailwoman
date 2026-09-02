/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `filer_family` write that accompanies a `HoldingCompany`/`ManagementCompany` edge.
 *
 *   A `filer_edge` row ALONE is invisible to `familyRollup`/`filerLookup.families` — both answer "which family
 *   does this node belong to" from `filer_family` alone. An ownership/control edge and its family membership are
 *   therefore two writes of ONE fact, and every caller emitting the first must emit the second.
 */

import type { StatementSync } from "@mailwoman/sqlite/client"

import { mintFamilyID } from "#sdk/family-id"

// mintFamilyID lives in family-id.ts — filer-lookup.ts's readFamilyDisplayNames needs the
// identical canonicalization rule to tell apart which target node's edge names a given family_id, and re-deriving it
// a second time independently would be exactly the "two definitions that can drift" hazard guards.ts's own extraction
// already closed for assertISODate.

/**
 * The one `filer_family` row {@linkcode insertFamilyMembership} writes, described in the builder's own terms rather
 * than the table's: `memberNodeID`/`namingNodeID` are the two ends of the `HoldingCompany`/`ManagementCompany` edge
 * this row accompanies, and `identifierType`/`name` are what {@linkcode mintFamilyID} canonicalizes into the
 * `family_id`.
 */
export interface FamilyMembershipFact {
	/**
	 * The edge's `from_node_id` — an FRN or `bdcProviderID` node. Becomes `filer_family.node_id`.
	 */
	memberNodeID: string
	/**
	 * The edge's `to_node_id` — the holding-/management-company node whose raw name produced `family_id`. Becomes
	 * `filer_family.naming_node_id`.
	 */
	namingNodeID: string
	/**
	 * One of {@link FilerIdentifierType} — the namespace `family_id` is minted under.
	 */
	identifierType: string
	/**
	 * The RAW company name, canonicalized by {@linkcode mintFamilyID}. Never written verbatim to `filer_family`; the raw
	 * spelling lives on the `filer_node` `namingNodeID` points at.
	 */
	name: string
	/**
	 * One of {@link FilerRelationship} — copied from the accompanying edge, never re-derived.
	 */
	relationship: string
	/**
	 * One of {@link FilerEdgeAssertion} — copied from the accompanying edge, never re-derived. Required rather than
	 * defaulted to `Authoritative`: a new family writer must state the strength of its claim on purpose, and a default
	 * would let an inferred one inherit authority by omission — the exact conflation criterion 2 exists to prevent.
	 */
	assertion: string
	/**
	 * The inferred match's score; `null` on an authoritative membership, where nothing was matched (the schema's own
	 * CHECK constraint rejects a score there — see `createFilerFamilyTable`).
	 */
	matchScore: number | null
	source: string
	sourceVintage: string
	validFrom: string
}

/**
 * Write one `filer_family` membership row for a `HoldingCompany`/`ManagementCompany` edge's SOURCE node (the edge's own
 * `from_node_id` — an FRN or `bdcProviderID`) — see {@linkcode mintFamilyID} for how `family_id` is derived from the
 * TARGET name's canonical form. Skips silently (no row, no error, no `skipped` increment — a family row is a bonus
 * derived fact, not an edge opportunity) when the name canonicalizes to nothing. `insFamily` (the prepared statement it
 * writes through) is passed in rather than closed over, so every emission path writes through the ONE statement
 * `buildFilerDatabase` prepared against the shared handle.
 *
 * {@link FamilyMembershipFact.namingNodeID} is the company node this row's `family_id` was minted FROM — the edge's
 * `to_node_id`, which every caller has already minted immediately above its call. It is deliberately taken as a field
 * rather than re-derived from `identifierType`/`name` here, so the family row and the edge can never name two different
 * nodes. Persisting it is what lets `filer-lookup.ts`'s `readFamilyDisplayNames` recover the raw spelling by a plain
 * join instead of re-running `canonicalizeOrganizationName` at read time against a sealed, separately-versioned
 * artifact — see `schema.ts`'s file header for the drift that closed. Adding it pushed this function's positional arity
 * past the linter's `max-params` ceiling, hence the single options argument.
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
