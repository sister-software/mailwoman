/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reassemble the FULL parsed street name from a street node's subtree — `street.value` alone is
 *   the bare base ("Sheldon" for "East Sheldon Rd"), so the result surface rebuilds the name from
 *   every name-bearing tag, ordered by span offset. Hoisted out of `geocode-core.ts` verbatim (its
 *   only caller) as a standalone pure unit.
 */

import type { AddressNode } from "@mailwoman/core/decoder"

/**
 * Street-name component tags — the name-bearing subtree of a `street` node (`street.value` alone is the bare base:
 * "Sheldon" for "East Sheldon Rd"). Mirrors the resolver's `assembleStreetValue`; used to surface the FULL parsed
 * street on the result so a house-grade forward consumer renders "Boulevard du Palais", not just "Palais". #1041.
 */
const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * Reassemble the full parsed street name from a street node's name-bearing subtree, ordered by span offset. #1041.
 */
export function assembleStreetName(streetNode: AddressNode): string {
	const parts: AddressNode[] = []
	const stack = [streetNode]

	while (stack.length) {
		const n = stack.pop()!

		if (STREET_NAME_TAGS.has(n.tag) && n.value.trim()) {
			parts.push(n)
		}

		stack.push(...n.children)
	}

	parts.sort((a, b) => a.start - b.start)

	return parts.map((n) => n.value.trim()).join(" ")
}
