/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Aliases and containment. An alias is text that may refer to an entity. It resolves only when exactly
 *   one candidate holds evidence, and two candidates stay two. A containment link relates a child to a
 *   parent through one source record, so a parcel with two buildings keeps both.
 */

import type { PostalAddress } from "@mailwoman/record"

import type { EntityID } from "#identifiers"
import type { SourceRecordID } from "#sources"
import type { ClaimInterval, ISODate } from "#time"

export interface Evidence extends ClaimInterval {
	source: SourceRecordID
	observedAt?: ISODate
}

export interface AliasCandidate {
	entity: EntityID
	evidence: Evidence
}

export interface Alias {
	text: string
	address?: PostalAddress
	candidates: readonly AliasCandidate[]
}

/**
 * The three containment links a dossier holds, as wire values: an entrance of a building,
 * a unit of a building, a building on a parcel.
 */
export const ContainmentRelation = {
	EntranceOf: "entrance_of",
	UnitOf: "unit_of",
	BuildingOn: "building_on",
} as const

export type ContainmentRelation = (typeof ContainmentRelation)[keyof typeof ContainmentRelation]

export interface Containment {
	child: EntityID
	parent: EntityID
	relation: ContainmentRelation
	evidence: Evidence
}

export type AliasResolution =
	| { kind: "resolved"; entity: EntityID; evidence: Evidence }
	| { kind: "ambiguous"; candidates: readonly AliasCandidate[] }
	| { kind: "unlinked" }

export function resolveAlias(alias: Alias): AliasResolution {
	if (!alias.candidates.length) return { kind: "unlinked" }

	const distinct = new Set(alias.candidates.map((candidate) => candidate.entity))

	if (distinct.size > 1) return { kind: "ambiguous", candidates: alias.candidates }

	const [first] = alias.candidates

	return { kind: "resolved", entity: first!.entity, evidence: first!.evidence }
}

export function entrancesOf(building: EntityID, links: readonly Containment[]): readonly Containment[] {
	return links.filter((link) => link.parent === building && link.relation === ContainmentRelation.EntranceOf)
}

export function unitsOf(building: EntityID, links: readonly Containment[]): readonly Containment[] {
	return links.filter((link) => link.parent === building && link.relation === ContainmentRelation.UnitOf)
}

export function buildingsOn(parcel: EntityID, links: readonly Containment[]): readonly Containment[] {
	return links.filter((link) => link.parent === parcel && link.relation === ContainmentRelation.BuildingOn)
}
