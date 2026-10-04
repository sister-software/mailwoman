/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit counts stay interpretable. Each count states what it counts (the stage), for which object, on
 *   which date, over which set of units (the membership key), and from which record. A total exists only
 *   when the contributing counts share stage and date and cover disjoint memberships. Otherwise the
 *   result is unresolved and lists the counts that conflict.
 */

import type { EntityID } from "#identifiers"
import type { Evidence } from "#links"
import type { ISODate } from "#time"

/**
 * The three stages a unit count can describe, as wire values: planned, completed and occupied.
 */
export const UnitStage = {
	Planned: "planned",
	Completed: "completed",
	Occupied: "occupied",
} as const

export type UnitStage = (typeof UnitStage)[keyof typeof UnitStage]

export interface UnitCount {
	id: string
	subject: EntityID
	stage: UnitStage
	count: number
	at: ISODate
	/**
	 * The supplier's key for the set of units this count covers.
	 * Two counts over one key describe the same units.
	 */
	membership: string
	evidence: Evidence
}

export type UnitTotal =
	| { status: "resolved"; stage: UnitStage; at: ISODate; total: number; parts: readonly UnitCount[] }
	| { status: "unresolved"; stage: UnitStage; at: ISODate; reason: string; conflicting: readonly UnitCount[] }

export interface UnitTotalQuery {
	subjects: readonly EntityID[]
	stage: UnitStage
	at: ISODate
}

export function countsByStage(
	counts: readonly UnitCount[],
	subject: EntityID
): Record<UnitStage, readonly UnitCount[]> {
	const mine = counts.filter((count) => count.subject === subject)

	return {
		planned: mine.filter((count) => count.stage === UnitStage.Planned),
		completed: mine.filter((count) => count.stage === UnitStage.Completed),
		occupied: mine.filter((count) => count.stage === UnitStage.Occupied),
	}
}

export function totalUnits(counts: readonly UnitCount[], query: UnitTotalQuery): UnitTotal {
	const subjects = new Set(query.subjects)

	const matching = counts.filter(
		(count) => subjects.has(count.subject) && count.stage === query.stage && count.at === query.at
	)

	const unresolved = (reason: string, conflicting: readonly UnitCount[]): UnitTotal => ({
		status: "unresolved",
		stage: query.stage,
		at: query.at,
		reason,
		conflicting,
	})

	if (!matching.length) return unresolved(`no ${query.stage} count on ${query.at} for ${[...subjects].join(", ")}`, [])

	const byMembership = new Map<string, UnitCount[]>()

	for (const count of matching) {
		byMembership.set(count.membership, [...(byMembership.get(count.membership) ?? []), count])
	}

	for (const [membership, group] of byMembership) {
		const subjectsInGroup = new Set(group.map((count) => count.subject))

		if (subjectsInGroup.size > 1) {
			return unresolved(
				`membership ${membership} is claimed by two subjects: ${[...subjectsInGroup].join(", ")}`,
				group
			)
		}

		const values = new Set(group.map((count) => count.count))

		if (values.size > 1) {
			return unresolved(
				`${group.length} counts share the same subject, stage, date and membership (${membership}) and disagree: ${[...values].join(" versus ")}`,
				group
			)
		}
	}

	const parts = [...byMembership.values()].map((group) => group[0]!)

	return {
		status: "resolved",
		stage: query.stage,
		at: query.at,
		total: parts.reduce((sum, count) => sum + count.count, 0),
		parts: matching,
	}
}
