// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { OUTCOME_KINDS, type OutcomeKind } from "#whosonfirst/outcomes/kinds"

/**
 * Whether a string is the name of a member of the outcome vocabulary.
 *
 * @public
 */
export function isOutcomeKind(value: string): value is OutcomeKind {
	return Object.hasOwn(OUTCOME_KINDS, value)
}

/**
 * Whether a record's member satisfies a requested id: the id equals the member or is its parent.
 *
 * `natural` is satisfied by `natural.mountain`, and `natural.mountain` isn't satisfied by `natural.water`.
 *
 * @public
 */
export function outcomeSatisfies(member: OutcomeKind, requested: OutcomeKind): boolean {
	return member === requested || OUTCOME_KINDS[member].parent === requested
}

/**
 * The member a deprecated id is read through, following `supersededBy` to a current member.
 *
 * @public
 */
export function currentOutcomeKind(kind: OutcomeKind): OutcomeKind {
	let current = kind

	for (let step = 0; ; step++) {
		// Widened, because a vocabulary with zero deprecated members types every status as `"current"`.
		const row: { status: string; supersededBy: string | null } = OUTCOME_KINDS[current]

		if (row.status !== "deprecated") return current

		const next = row.supersededBy

		if (!next || !isOutcomeKind(next) || step > Object.keys(OUTCOME_KINDS).length) {
			throw new Error(`The outcome kind ${kind} is deprecated without a current replacement.`)
		}

		current = next
	}
}
