/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolvedPlace } from "@mailwoman/core/resolver"

/**
 * The default bonus, in log10-population units, that {@link rankByCountryPrior}
 * gives a candidate in the locale country.
 *
 * A weight of 2 lets an in-country place be up to 100 times smaller and still win.
 */
export const DEFAULT_COUNTRY_PRIOR_WEIGHT = 2

const SAME_COUNTRY_IMPORTANCE_TIE_BAND = 0.02

type Rankable = Pick<ResolvedPlace, "score"> &
	Partial<Pick<ResolvedPlace, "country" | "exactMatch" | "importance" | "population" | "prominence">>

function rankWithinTier<T extends Rankable>(candidates: readonly T[], compare: (a: T, b: T) => number): T[] {
	const exact: T[] = []
	const rest: T[] = []

	for (const c of candidates) {
		;(c.exactMatch === true ? exact : rest).push(c)
	}

	return [...exact.toSorted(compare), ...rest.toSorted(compare)]
}

const size = (c: Rankable): number => c.prominence ?? c.score

const measured = (c: Rankable): boolean => typeof c.importance === "number" && Number.isFinite(c.importance)

function reorderMeasured<T extends Rankable>(tier: readonly T[], order: (measuredRows: T[]) => T[]): T[] {
	const slots: number[] = []

	for (const [i, c] of tier.entries()) {
		if (measured(c)) {
			slots.push(i)
		}
	}

	if (slots.length < 2) return [...tier]
	const sorted = order(slots.map((i) => tier[i]!))
	const out = [...tier]

	for (const [k, slot] of slots.entries()) {
		out[slot] = sorted[k]!
	}

	return out
}

const counted = (c: Rankable): boolean => typeof c.population === "number" && c.population > 0

function countedFirstWithinCountry<T extends Rankable>(rows: readonly T[]): T[] {
	const out = [...rows]
	const slotsByCountry = new Map<string, number[]>()

	for (const [index, row] of out.entries()) {
		const country = row.country?.toUpperCase()

		if (!country) continue

		const slots = slotsByCountry.get(country) ?? []

		slots.push(index)
		slotsByCountry.set(country, slots)
	}

	for (const slots of slotsByCountry.values()) {
		if (slots.length < 2) continue

		const members = slots.map((slot) => out[slot]!)
		const reordered = [...members.filter((row) => counted(row)), ...members.filter((row) => !counted(row))]

		for (const [k, slot] of slots.entries()) {
			out[slot] = reordered[k]!
		}
	}

	return out
}

function orderMeasuredByImportance<T extends Rankable>(rows: readonly T[]): T[] {
	const groups = new Map<string, { firstIndex: number; members: T[] }>()
	const clusters: Array<{ firstIndex: number; members: T[] }> = []

	for (const [i, row] of rows.entries()) {
		const country = row.country?.toUpperCase()

		if (!country) {
			clusters.push({ firstIndex: i, members: [row] })

			continue
		}

		const group = groups.get(country)

		if (group) {
			group.members.push(row)
		} else {
			groups.set(country, { firstIndex: i, members: [row] })
		}
	}

	for (const group of groups.values()) {
		const sorted = group.members.toSorted((a, b) => b.importance! - a.importance! || size(b) - size(a))
		let open: T[] = []

		for (const row of sorted) {
			if (open.length && open.at(-1)!.importance! - row.importance! > SAME_COUNTRY_IMPORTANCE_TIE_BAND) {
				clusters.push({ firstIndex: group.firstIndex, members: open })
				open = []
			}

			open.push(row)
		}

		if (open.length) {
			clusters.push({ firstIndex: group.firstIndex, members: open })
		}
	}

	const keyed = clusters.map((cluster) => ({
		firstIndex: cluster.firstIndex,
		key: Math.max(...cluster.members.map((m) => m.importance!)),
		members: cluster.members.toSorted((a, b) => size(b) - size(a)),
	}))

	keyed.sort((a, b) => b.key - a.key || size(b.members[0]!) - size(a.members[0]!) || a.firstIndex - b.firstIndex)

	return countedFirstWithinCountry(keyed.flatMap((c) => c.members))
}

/**
 * Reorders candidates by gazetteer `importance`, highest first, within the exact-match
 * and partial-match tiers.
 *
 * Candidates without an importance keep their positions.
 * Same-country candidates whose importance differs by at most 0.02 are ordered by size
 * instead, with populated places first within each country.
 */
export function rankByImportance<T extends Rankable>(candidates: readonly T[]): T[] {
	if (candidates.length < 2) return [...candidates]

	if (!candidates.some(measured)) return [...candidates]

	const exact: T[] = []
	const rest: T[] = []

	for (const c of candidates) {
		;(c.exactMatch === true ? exact : rest).push(c)
	}

	return [...reorderMeasured(exact, orderMeasuredByImportance), ...reorderMeasured(rest, orderMeasuredByImportance)]
}

/**
 * Reorders candidates within each match tier by size, adding `weight` for candidates in `country`.
 *
 * It returns the candidates unchanged when no country is given.
 * The bonus is additive, so a much larger foreign place of the same name still wins.
 */
export function rankByCountryPrior<T extends Rankable>(
	candidates: readonly T[],
	country: string | undefined,
	weight: number = DEFAULT_COUNTRY_PRIOR_WEIGHT
): T[] {
	if (!country || candidates.length < 2) return [...candidates]
	const target = country.toUpperCase()

	const key = (c: T): number => size(c) + (c.country?.toUpperCase() === target ? weight : 0)

	return rankWithinTier(candidates, (a, b) => key(b) - key(a))
}

/**
 * Returns a place's capital status: 2 for a national capital, 1 for an admin-1 seat, and 0 otherwise.
 *
 * The caller supplies it, so the resolver never loads a capitals reference itself.
 */
export type CapitalLevelFn = (place: Pick<ResolvedPlace, "name" | "country" | "lat" | "lon">) => number

const PROMOTABLE_CAPITAL_LEVEL = 2

/**
 * The size lead, in log10-population units, that another place needs to stay ahead of a national capital.
 *
 * A value of 2 means 100 times more populous.
 */
export const NATIONAL_CAPITAL_MARGIN_LOG10 = 2

/**
 * Moves the first national capital in the leading match tier above each preceding row that
 * is at most {@link NATIONAL_CAPITAL_MARGIN_LOG10} larger, stopping at another capital.
 *
 * It runs after {@link rankByImportance} and never moves a capital across the exact-match boundary.
 */
export function promoteCapitals<T extends Rankable & Pick<ResolvedPlace, "name" | "country" | "lat" | "lon">>(
	candidates: readonly T[],
	level: CapitalLevelFn | undefined
): T[] {
	if (!level || candidates.length < 2) return [...candidates]

	const exact: T[] = []
	const rest: T[] = []

	for (const c of candidates) {
		;(c.exactMatch === true ? exact : rest).push(c)
	}

	const tier = exact.length ? exact : rest
	const best = tier.findIndex((c) => level(c) >= PROMOTABLE_CAPITAL_LEVEL)

	if (best <= 0) return [...candidates]

	let target = best

	while (target > 0) {
		const above = tier[target - 1]!

		if (level(above) >= PROMOTABLE_CAPITAL_LEVEL) break

		if (size(tier[best]!) + NATIONAL_CAPITAL_MARGIN_LOG10 < size(above)) break

		target--
	}

	if (target === best) return [...candidates]

	const reordered = [...tier]
	const [capital] = reordered.splice(best, 1)

	reordered.splice(target, 0, capital!)

	return exact.length ? [...reordered, ...rest] : reordered
}
