// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The outcome partition, order 4 in the pass table of `docs/engineering/reference/outcome-kinds.mdx`,
 *   and the cross-layer merge it runs over.
 *
 *   The partition moves candidates only inside one conformance class.
 *   Each class keeps the positions its members held, so a candidate the stated
 *   geography doesn't admit never moves ahead of one it does.
 */

import type { ResolvedPlace } from "@mailwoman/core/resolver"
import { OutcomeLayer, outcomeSatisfies, outcomesSatisfy, unionOutcomes } from "@mailwoman/core/resolver/outcome"

/**
 * The order of the data layers when cross-layer prominence is missing.
 */
const LAYER_ORDER: readonly string[] = [OutcomeLayer.Candidate, OutcomeLayer.Landmarks, OutcomeLayer.OpenStreetMap]

/**
 * What the partition orders by: the request's hint, or the head's readings when no hint is set.
 */
export interface OutcomeOrder {
	hint: string | null
	/**
	 * The head's identity top levels, most probable first.
	 * Read only without a hint.
	 */
	headOrder: readonly string[] | null
}

/**
 * The key two candidates share when they're in one conformance class: the `exactMatch` tier,
 * whether the postcode's country posterior gives the candidate's country mass, and
 * whether the stated country and locality admit a landmark or OpenStreetMap candidate.
 */
export function conformanceKey(
	candidate: ResolvedPlace,
	posterior: Readonly<Record<string, number>> | null | undefined
): string {
	const exact = candidate.exactMatch === true ? "1" : "0"

	const mass = posterior ? (candidate.country && (posterior[candidate.country] ?? 0) > 0 ? "1" : "0") : "-"

	const admitted = candidate.contextAdmits === false ? "0" : "1"

	return `${exact}${mass}${admitted}`
}

/**
 * Whether a place satisfies a requested outcome id.
 * A place whose set wasn't read satisfies none.
 */
export function placeSatisfies(place: Pick<ResolvedPlace, "outcomes">, requested: string): boolean {
	return outcomesSatisfy([requested], place.outcomes ?? [])
}

/**
 * The group a candidate falls in: 0 before 1, and so on.
 *
 * With a hint, the satisfying candidates are group 0 and the rest group 1.
 * With the head's order, a candidate's group is the best rank among its identity top levels,
 * and a candidate with none of them follows every reading.
 */
function groupOf(candidate: Pick<ResolvedPlace, "outcomes">, order: OutcomeOrder): number {
	if (order.hint != null) return placeSatisfies(candidate, order.hint) ? 0 : 1

	const readings = order.headOrder ?? []

	const ranks = (candidate.outcomes ?? [])
		.map((m) => readings.findIndex((reading) => outcomeSatisfies(reading, m.outcome)))
		.filter((rank) => rank >= 0)

	return ranks.length ? Math.min(...ranks) : readings.length
}

function layerRank(candidate: ResolvedPlace): number {
	const rank = LAYER_ORDER.indexOf(candidate.layer ?? OutcomeLayer.Candidate)

	return rank === -1 ? LAYER_ORDER.length : rank
}

/**
 * Orders one group: each layer keeps its own order, and the layers interleave by the
 * comparable prominence `s(e)` when every member has it, or follow the layer order otherwise.
 */
function orderGroup(members: readonly ResolvedPlace[]): ResolvedPlace[] {
	if (!members.every((m) => typeof m.sitelinkProminence === "number")) {
		return members.toSorted((a, b) => layerRank(a) - layerRank(b))
	}

	// A merge of the per-layer runs: the next member is the run head with the largest `s(e)`.
	const runs = LAYER_ORDER.map((layer) => members.filter((m) => (m.layer ?? OutcomeLayer.Candidate) === layer))
	const merged: ResolvedPlace[] = []

	while (runs.some((run) => run.length)) {
		let best = -1

		for (let i = 0; i < runs.length; i++) {
			if (!runs[i]!.length) continue

			if (best < 0 || runs[i]![0]!.sitelinkProminence! > runs[best]![0]!.sitelinkProminence!) {
				best = i
			}
		}

		merged.push(runs[best]!.shift()!)
	}

	return merged
}

/**
 * The outcome partition.
 *
 * Inside each conformance class, the candidates are grouped by {@link OutcomeOrder},
 * and the class's members refill the positions the class held.
 * Without a hint or a head order, the list returns unchanged.
 */
export function partitionByOutcome(
	ranked: readonly ResolvedPlace[],
	order: OutcomeOrder,
	posterior: Readonly<Record<string, number>> | null | undefined
): ResolvedPlace[] {
	if (order.hint == null && !order.headOrder?.length) return [...ranked]

	const classes = new Map<string, number[]>()

	ranked.forEach((candidate, index) => {
		const key = conformanceKey(candidate, posterior)
		const slots = classes.get(key) ?? []

		slots.push(index)
		classes.set(key, slots)
	})

	const out: ResolvedPlace[] = [...ranked]

	for (const slots of classes.values()) {
		const members = slots.map((i) => ranked[i]!)
		const groups = new Map<number, ResolvedPlace[]>()

		for (const member of members) {
			const group = groupOf(member, order)

			groups.set(group, [...(groups.get(group) ?? []), member])
		}

		const reordered = [...groups.entries()].toSorted(([a], [b]) => a - b).flatMap(([, group]) => orderGroup(group))

		slots.forEach((slot, i) => {
			out[slot] = reordered[i]!
		})
	}

	return out
}

/**
 * Orders the rows of one data layer, all in one conformance class, by {@link OutcomeOrder},
 * keeping the layer's order inside each group.
 */
export function orderWithinLayerByOutcome<T extends Pick<ResolvedPlace, "outcomes">>(
	rows: readonly T[],
	order: OutcomeOrder
): T[] {
	if (order.hint == null && !order.headOrder?.length) return [...rows]

	return rows
		.map((row, index) => ({ row, index, group: groupOf(row, order) }))
		.toSorted((a, b) => a.group - b.group || a.index - b.index)
		.map(({ row }) => row)
}

/**
 * Merges candidates that share a Wikidata item into one, keeping the first one's place and position.
 *
 * The merged candidate's set is the union of both sets, each member with the sources of both.
 * Two candidates without a shared item stay two.
 */
export function mergeByWikidata(candidates: readonly ResolvedPlace[]): ResolvedPlace[] {
	const byItem = new Map<string, ResolvedPlace>()
	const out: ResolvedPlace[] = []

	for (const candidate of candidates) {
		const item = candidate.wikidata
		const held = item ? byItem.get(item) : undefined

		if (!held) {
			const kept = { ...candidate }

			out.push(kept)

			if (item) {
				byItem.set(item, kept)
			}

			continue
		}

		held.outcomes = unionOutcomes(held.outcomes ?? [], candidate.outcomes ?? [])
		held.sitelinkProminence ??= candidate.sitelinkProminence ?? null
	}

	return out
}

/**
 * Merges two fetches of one data layer by place id, the first fetch's rows first.
 */
export function mergeFetches(first: readonly ResolvedPlace[], second: readonly ResolvedPlace[]): ResolvedPlace[] {
	const seen = new Set(first.map((c) => String(c.id)))

	return [...first, ...second.filter((c) => !seen.has(String(c.id)))]
}
