/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Both decision sites call this ordering function.
 *   The candidate backend partitions rows before the limit window. The resolver walk partitions again after fame and anchor re-ranking.
 */

import { firstNodeWhere, type AddressNode } from "@mailwoman/core/decoder"

/**
 * Find the first non-empty region-tagged span anywhere in a tree — the qualifier the
 * walk threads onto locality lookups, deliberately the same node the admin-coherence
 * verdicts read so the two populations coincide.
 */
export function firstRegionQualifier(roots: readonly AddressNode[]): string | null {
	return firstNodeWhere(roots, (n) => n.tag === "region" && n.value.trim())?.value.trim() ?? null
}

/**
 * Stable, tier-safe, positive-evidence-only partition: within each match tier,
 * candidates vouched for by the containment source (`isContained`) move ahead of the others.
 * Both groups keep their incoming relative order.
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
 * The trace verdict for one locality pick, stamped as `metadata.admin_containment`:
 * any `true` → `"contained"`; stamps present but none true → `"no_contained_candidate"`;
 * no stamps at all → `"unavailable"`.
 */
export function adminContainmentVerdict(
	candidates: ReadonlyArray<{ containedByQualifier?: boolean | null }>
): "contained" | "no_contained_candidate" | "unavailable" {
	let evaluated = false

	for (const candidate of candidates) {
		if (candidate.containedByQualifier === true) return "contained"

		if (candidate.containedByQualifier != null) {
			evaluated = true
		}
	}

	return evaluated ? "no_contained_candidate" : "unavailable"
}
