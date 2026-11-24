// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Country groupings: organizations such as the G20 and the EU, and classifications such
 *   as the IMF advanced economies, with each country's membership between stated dates.
 *
 *   Every question takes a date, because a grouping's members change:
 *   the United Kingdom left the EU on 2020-01-31.
 *   A grouping the normalizer couldn't classify throws with its reasons
 *   rather than answering with no members.
 */

import { GROUPING_IDS, type GroupingID, groupingRows, membershipRows } from "#artifacts/groupings/groupings"
import type { GroupingRecord, MembershipRow } from "#types"

/**
 * A member of a grouping on one date.
 */
export interface GroupingMember {
	/**
	 * The ISO 3166-1 alpha-2 code, or the publisher's own code when `codeStatus` is `source-extension`.
	 */
	code: string
	codeStatus: MembershipRow["codeStatus"]
	/**
	 * True when the source states no start for the membership interval that covers the date.
	 * The member is then assumed to have joined before the date.
	 */
	startUnknown: boolean
}

/**
 * Raised for a question about a grouping whose source statements the normalizer couldn't classify.
 */
export class BlockedGroupingError extends Error {
	readonly grouping: GroupingID
	readonly reasons: readonly string[]

	constructor(grouping: GroupingID, reasons: readonly string[]) {
		super(`grouping ${grouping} is blocked: ${reasons.join("; ")}`)
		this.name = "BlockedGroupingError"
		this.grouping = grouping
		this.reasons = reasons
	}
}

/**
 * Returns whether `value` is a declared grouping ID.
 */
export function isGroupingID(value: string): value is GroupingID {
	return (GROUPING_IDS as readonly string[]).includes(value)
}

/**
 * Returns the grouping's record: its name, kind, source and the reasons it is blocked, if any.
 */
export function getGrouping(id: GroupingID): GroupingRecord {
	return groupingRows().find((grouping) => grouping.id === id)!
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether a membership interval covers `at`.
 *
 * A start or end stated at year or month precision is read as the first day of its year or month.
 * The end date is the first day outside the interval.
 */
function covers(row: MembershipRow, at: string): boolean {
	return (!row.start || row.start.date <= at) && (!row.end || at < row.end.date)
}

/**
 * Returns the members of `id` on the date `at` (`YYYY-MM-DD`), one entry per code, sorted by code.
 *
 * Associates, observers and suspended members are excluded.
 *
 * @throws {@linkcode BlockedGroupingError} When the grouping is blocked.
 */
export function groupingMembers(id: GroupingID, options: { at: string }): GroupingMember[] {
	if (!ISO_DATE.test(options.at)) throw new RangeError(`at must be YYYY-MM-DD, got ${options.at}`)

	const grouping = getGrouping(id)

	if (grouping.blockedBy.length) throw new BlockedGroupingError(id, grouping.blockedBy)

	const members = new Map<string, GroupingMember>()

	for (const row of membershipRows()) {
		if (row.grouping !== id || row.role !== "member" || !covers(row, options.at)) continue

		const earlier = members.get(row.code)
		const startUnknown = !row.start

		members.set(row.code, {
			code: row.code,
			codeStatus: row.codeStatus,
			startUnknown: earlier ? earlier.startUnknown && startUnknown : startUnknown,
		})
	}

	return [...members.values()].toSorted((a, b) => a.code.localeCompare(b.code))
}

/**
 * Returns the IDs of the groupings `code` belonged to on the date `at`, leaving out blocked groupings.
 */
export function groupingsOf(code: string, options: { at: string }): GroupingID[] {
	if (!ISO_DATE.test(options.at)) throw new RangeError(`at must be YYYY-MM-DD, got ${options.at}`)

	const blocked = new Set(
		groupingRows()
			.filter((grouping) => grouping.blockedBy.length)
			.map((grouping) => grouping.id)
	)

	const ids = new Set<GroupingID>()

	for (const row of membershipRows()) {
		if (row.code === code && row.role === "member" && !blocked.has(row.grouping) && covers(row, options.at)) {
			ids.add(row.grouping as GroupingID)
		}
	}

	return GROUPING_IDS.filter((id) => ids.has(id))
}
