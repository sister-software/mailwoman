/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A claim is one statement about one entity on one axis, with the record that supports it and the
 *   status that says how it was established. The status is the discriminant of the union, so an inferred
 *   claim states its explanation and derivation and can never be assigned where an observed claim is
 *   expected.
 *
 *   A derived or inferred claim rests on the claims it derives from. A dossier therefore admits it only
 *   when it admits each of those claims, whatever the date of the claim's own source record.
 */

import type { EpistemicStatus } from "@mailwoman/evidence"

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"
import type { SourceRecordID } from "#sources"

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

/**
 * The identifiers of the claims that `claim` derives from.
 *
 * A designated or observed claim derives from no claim, so its list is empty.
 */
export function derivationOf(claim: Claim): readonly string[] {
	return claim.status === "derived" || claim.status === "inferred" ? claim.derivedFrom : []
}

/**
 * The claims a dossier admits, in the supplied order.
 *
 * A claim is admitted when its source record is admitted.
 * A derived or inferred claim is admitted only when every claim it derives from is admitted too,
 * so a claim derived from a claim that is dropped or never supplied is dropped as well.
 */
export function admittedClaims(claims: readonly Claim[], admittedSources: ReadonlySet<SourceRecordID>): Claim[] {
	let admitted = claims.filter((claim) => admittedSources.has(claim.evidence.source))
	let previous: number

	// A dropped claim takes the claims derived from it with it, so the filter repeats until it drops no claim.
	do {
		previous = admitted.length

		const ids = new Set(admitted.map((claim) => claim.id))

		admitted = admitted.filter((claim) => derivationOf(claim).every((id) => ids.has(id)))
	} while (admitted.length < previous)

	return admitted
}
