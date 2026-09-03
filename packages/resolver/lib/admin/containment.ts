/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The admin-containment partition (#1717 stage 2) — the ONE ordering function both deciding sites
 *   call, per the #861 rule (shared constants prove nothing; the #861 parity contract diverged at
 *   exactly the points a constant cannot express). The candidate backend partitions its row set
 *   before the limit window (so a contained candidate can reach the walk at all), and the resolver
 *   walk partitions AGAIN after its fame/anchor re-ranks (so `rankByImportance` cannot hand the top
 *   slot back to a more-famous uncontained namesake — Richmond VA outscores Richmond, North
 *   Yorkshire on importance, and without the second partition the change loses exactly where fame
 *   disagrees with the qualifier). Two call sites, one function, one ordering.
 */

import type { AddressNode } from "@mailwoman/core/decoder"

/**
 * Find the first non-empty region-tagged span anywhere in a tree — the qualifier the walk threads onto locality
 * lookups. Deliberately the same node the admin-coherence VERDICTS read (the first `region` node), so the change's
 * firing population and the flag's `contradicted` population are the same rows. A `region` slot can hold a country name
 * the parser mislabeled ("Moscow, Russia" parses region="Russia") — the backend's qualifier probe answers that too,
 * because containment is containment whatever tier the container sits at.
 */
export function firstRegionQualifier(roots: readonly AddressNode[]): string | undefined {
	const stack = [...roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.tag === "region" && n.value.trim().length) return n.value.trim()
		stack.push(...n.children)
	}

	return undefined
}

/**
 * Stable, TIER-SAFE partition: within each match tier, candidates the containment source vouched for (`isContained`)
 * move ahead of the rest, and BOTH groups keep their incoming relative order — the same house rules every soft ranking
 * key here obeys (`toponym-prior.ts`): tier-safe (a contained partial match never outranks an exact one — `isExact`
 * splits the population exactly as `rankWithinTier`'s tri-state rule does, only a stated exact tier earns the front),
 * positive-evidence-only (only a stated `true` moves a row; `false` and "never evaluated" both hold their incoming
 * rank, so an incapable backend is a no-op by construction), and stable (the backend's own ordering survives within
 * each (tier, containment) cell).
 *
 * Implemented with the slot idiom (`reorderMeasured`'s mechanics): each tier's members permute only among the positions
 * that tier already occupies, so a tier-interleaved list — the walk's no-importance path never regrouped tiers — cannot
 * have a rest-tier row promoted across an exact-tier boundary by this partition.
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
 * The trace verdict for one locality pick under the change — stamped as `metadata.admin_containment` so an inert
 * mechanism is visible in the result rather than silently dead (#1719's rule). Derived from the candidates'
 * `containedByQualifier` stamps: any `true` → `"contained"`; stamps present but none true → `"no_contained_candidate"`;
 * no stamps at all → `"unavailable"` (the backend or artifact cannot answer — a pre-sidecar candidate.db, the FTS or
 * browser backend, or a qualifier the probe never ran for).
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
