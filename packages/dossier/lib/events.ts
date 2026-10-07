/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Commercial events and organizational roles. An inquiry, a commitment, an order, an active subscription,
 *   a landlord's permission and an accepted build are six different events, each with its own parties,
 *   physical scope and date. A permission reaches only the entities in its scope. An ownership or
 *   management record states who holds the role. The signing authority is a separate fact that stays
 *   unknown until a record states it.
 */

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"
import { compareISODate, type ISODate } from "#time"

/**
 * The six commercial event kinds a dossier distinguishes, as wire values.
 */
export const CommercialEventKind = {
	Inquiry: "inquiry",
	Commitment: "commitment",
	Order: "order",
	ActiveSubscription: "active_subscription",
	LandlordPermission: "landlord_permission",
	AcceptedBuild: "accepted_build",
} as const

export type CommercialEventKind = (typeof CommercialEventKind)[keyof typeof CommercialEventKind]

export interface Party {
	name: string
	role: string
}

export interface CommercialEvent {
	id: string
	kind: CommercialEventKind
	parties: readonly Party[]
	/**
	 * The entities the event applies to, and no wider.
	 */
	scope: readonly EntityID[]
	date: ISODate | null
	evidence: Evidence
}

export function eventsByKind(
	events: readonly CommercialEvent[],
	kind: CommercialEventKind
): readonly CommercialEvent[] {
	return events.filter((event) => event.kind === kind)
}

export interface ActiveSubscriptions {
	count: number
	events: readonly CommercialEvent[]
	/**
	 * Subscriptions without a date cannot be placed at the query date, so they are listed and never counted.
	 */
	undated: readonly CommercialEvent[]
}

export function activeSubscriptionsAt(
	events: readonly CommercialEvent[],
	subject: EntityID,
	date: ISODate
): ActiveSubscriptions {
	const subscriptions = eventsByKind(events, CommercialEventKind.ActiveSubscription).filter((event) =>
		event.scope.includes(subject)
	)

	const undated = subscriptions.filter((event) => event.date === null)
	const active = subscriptions.filter((event) => event.date !== null && compareISODate(event.date, date) <= 0)

	return { count: active.length, events: active, undated }
}

export function permissionCovers(events: readonly CommercialEvent[], entity: EntityID): readonly CommercialEvent[] {
	return eventsByKind(events, CommercialEventKind.LandlordPermission).filter((event) => event.scope.includes(entity))
}

/**
 * The organizational roles a building's records can name, as wire values.
 */
export const OrganizationRole = {
	Owner: "owner",
	Manager: "manager",
	Developer: "developer",
	Architect: "architect",
	Contractor: "contractor",
	Lender: "lender",
} as const

export type OrganizationRole = (typeof OrganizationRole)[keyof typeof OrganizationRole]

export interface OrganizationRelation {
	organization: string
	role: OrganizationRole
	subject: EntityID
	signingAuthority: "yes" | "no" | "unknown"
	evidence: Evidence
}

export function signingAuthorityFor(
	relations: readonly OrganizationRelation[],
	subject: EntityID
): { known: readonly OrganizationRelation[]; unknown: readonly OrganizationRelation[] } {
	const mine = relations.filter((relation) => relation.subject === subject)

	return {
		known: mine.filter((relation) => relation.signingAuthority !== "unknown"),
		unknown: mine.filter((relation) => relation.signingAuthority === "unknown"),
	}
}

export interface ConstructionWindow {
	subject: EntityID
	start: ISODate | null
	end: ISODate | null
	/**
	 * The stage the source states, such as `permit issued` or `rough-in`.
	 */
	stage: string
	evidence: Evidence
}
