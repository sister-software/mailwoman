/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A claim is one statement about one entity on one axis, with the record that supports it and the
 *   status that says how it was established. The status is the discriminant of the union, so an inferred
 *   claim states its explanation and derivation and can never be assigned where an observed claim is
 *   expected.
 */

import type { EpistemicStatus } from "@mailwoman/evidence"

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"

/**
 * The eight independent axes a claim addresses, as wire values: identity, premises,
 * network, access, engineering, product, demand and evidence.
 */
export const ClaimAxis = {
	Identity: "identity",
	Premises: "premises",
	Network: "network",
	Access: "access",
	Engineering: "engineering",
	Product: "product",
	Demand: "demand",
	Evidence: "evidence",
} as const

export type ClaimAxis = (typeof ClaimAxis)[keyof typeof ClaimAxis]

export interface ClaimBase<V> {
	id: string
	subject: EntityID
	axis: ClaimAxis
	predicate: string
	value: V
	evidence: Evidence
}

/**
 * The claim statuses a supplied record can carry.
 *
 * `unresolved` is a question, represented by {@link Unresolved} in the dossier, and never a claim value.
 */
export type ClaimStatus = Exclude<EpistemicStatus, "unresolved">

export type Claim<V = unknown> =
	| (ClaimBase<V> & { status: "designated" })
	| (ClaimBase<V> & { status: "observed" })
	| (ClaimBase<V> & { status: "derived"; derivedFrom: readonly string[] })
	| (ClaimBase<V> & { status: "inferred"; derivedFrom: readonly string[]; explanation: string })

export function claimsFor(subject: EntityID, claims: readonly Claim[], axis?: ClaimAxis): readonly Claim[] {
	return claims.filter((claim) => claim.subject === subject && (axis === undefined || claim.axis === axis))
}
