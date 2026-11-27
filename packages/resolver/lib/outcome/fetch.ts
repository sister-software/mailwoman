// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The outcome request's two fetches of each data layer: the usual fetch with the filter as its
 *   predicate, and a second fetch of the rows that satisfy the hint, or the head's first reading.
 */

import type { LandmarkHit, LandmarkLookup } from "@mailwoman/core/resolver"
import { admittedOutcomeIDs, type OutcomeQuery, type ResolveOutcome } from "@mailwoman/core/resolver/outcome"

import type { OutcomeOrder } from "#outcome/ordering"

/**
 * The node metadata key that marks the span outcome ordering applied to.
 */
export const OUTCOME_TARGET_KEY = "outcome_target"

/**
 * The node metadata key that holds the resolved place's outcome set.
 */
export const OUTCOME_SET_KEY = "outcomes"

/**
 * The query of the usual fetch: every row's set is read, and the filter admits rows.
 */
export function filterQuery(outcome: ResolveOutcome): OutcomeQuery {
	return {
		vocabulary: outcome.vocabulary,
		admit: outcome.filter ? admittedOutcomeIDs(outcome.filter, outcome.vocabulary) : null,
	}
}

/**
 * The reading the second fetch reads: the hint, or the head's first reading without one.
 */
export function secondFetchReading(outcome: ResolveOutcome): string | null {
	return outcome.hint ?? outcome.headOrder?.[0] ?? null
}

/**
 * The query of the second fetch, or null without a hint or a head order.
 *
 * Its rows satisfy the reading and, under a filter, the filter too.
 */
export function secondFetchQuery(outcome: ResolveOutcome): OutcomeQuery | null {
	const reading = secondFetchReading(outcome)

	if (reading == null) return null

	const filtered = filterQuery(outcome).admit
	const ids = admittedOutcomeIDs([reading], outcome.vocabulary)

	return { vocabulary: outcome.vocabulary, admit: filtered ? ids.filter((id) => filtered.includes(id)) : ids }
}

/**
 * The order the partition reads: the hint, or the head's order without one.
 */
export function outcomeOrderOf(outcome: ResolveOutcome): OutcomeOrder {
	return { hint: outcome.hint, headOrder: outcome.hint == null ? outcome.headOrder : null }
}

/**
 * A landmark layer's hits for a name under the outcome request: the filtered read,
 * then the rows of the second fetch it missed.
 */
export async function findWithOutcome(
	lookup: LandmarkLookup,
	name: string,
	outcome: ResolveOutcome
): Promise<LandmarkHit[]> {
	const read = (query: OutcomeQuery) => Promise.resolve(lookup.find.call(lookup, name, query))
	const first = await read(filterQuery(outcome))
	const second = secondFetchQuery(outcome)

	if (!second) return first

	const seen = new Set(first.map((hit) => hit.qid))

	return [...first, ...(await read(second)).filter((hit) => !seen.has(hit.qid))]
}
