/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one ordering function both deciding sites call: the candidate backend partitions its row set
 *   before the limit window, and the resolver walk partitions again after its fame/anchor re-ranks.
 */

import { firstNodeWhere, type AddressNode } from "@mailwoman/core/decoder"

/**
 * Find the first non-empty region-tagged span anywhere in a tree — the qualifier
 * the walk threads onto locality lookups, deliberately the same node the admin-coherence
 * verdicts read so the two populations coincide.
 */
export function firstRegionQualifier(roots: readonly AddressNode[]): string | undefined {
	return firstNodeWhere(roots, (n) => n.tag === "region" && n.value.trim())?.value.trim()
}

/**
 * Stable, tier-safe, positive-evidence-only partition: within each match tier, candidates the
 * containment source vouched for (`isContained`) move ahead of the rest, and both groups keep
 * their incoming relative order.
 */
export function partitionByContainment<T>(
	rows: readonly T[],
	isContained: (row: T) => boolean,
	isExact: (row: T) => boolean
): T[] {
	const out = [...rows]

	for (const wantExact of [true, false]) {
		const slots: number[] = []

		for (const [index, row] of out.entries()) {
			if (isExact(row) === wantExact) {
				slots.push(index)
			}
		}

		if (slots.length < 2) continue

		const members = slots.map((slot) => out[slot]!)
		const reordered = [...members.filter((row) => isContained(row)), ...members.filter((row) => !isContained(row))]

		for (const [k, slot] of slots.entries()) {
			out[slot] = reordered[k]!
		}
	}

	return out
}

/**
 * The trace verdict for one locality pick, stamped as `metadata.admin_containment`: any `true` →
 * `"contained"`; stamps present but none true → `"no_contained_candidate"`; no stamps at all →
 * `"unavailable"`.
 */
export function adminContainmentVerdict(
	candidates: ReadonlyArray<{ containedByQualifier?: boolean | undefined }>
): "contained" | "no_contained_candidate" | "unavailable" {
	let evaluated = false

	for (const candidate of candidates) {
		if (candidate.containedByQualifier === true) return "contained"

		if (candidate.containedByQualifier !== undefined) {
			evaluated = true
		}
	}

	return evaluated ? "no_contained_candidate" : "unavailable"
}
