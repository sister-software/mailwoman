/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Readers over the resolved tree's METADATA STAMPS — the receipts resolver mechanisms leave on nodes
 *   (`resolver_country`, the #42/#1735 scope stamps, the #1880 capital promotion). Extracted from
 *   `geocode-core.ts` as one unit: each is a walk that answers the first stamp it meets, each stamp's
 *   absence means "the mechanism never spoke", and none of them ranks anything.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"

/**
 * The resolved tree's own country — the first `resolver_country` stamp on any node (constant across one address's
 * resolved nodes), or undefined when nothing resolved with one. The rooftop second pass keys on this.
 */
export function resolvedCountryOf(tree: AddressTree): string | undefined {
	const stack: AddressNode[] = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!
		const c = (n.metadata?.["resolver_country"] as string | undefined)?.trim()

		if (c) return c.toUpperCase()

		stack.push(...n.children)
	}

	return undefined
}

/**
 * The #1880 capital promotion's stamp, read back off the resolved tree — the promoted candidate's country, or
 * `undefined` when no node's race was reordered by it.
 */
export function capitalPromotionOf(tree: AddressTree): string | undefined {
	const stack: AddressNode[] = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!
		const stamp = n.metadata?.["capital_promotion"]

		if (typeof stamp === "string" && stamp.length) return stamp

		if (stamp === true) return "unknown"

		stack.push(...n.children)
	}

	return undefined
}

/**
 * The country #42's postcode-country coherence pass scoped the walk to, read back off the resolved tree's
 * `postcode_country_scope` stamp — or the #1735 explicit-country pre-scope, whose receipt exists precisely so a tree
 * that was right from the start still gets its country's rooftop shard loaded. `undefined` whenever nothing was
 * overridden.
 */
export function postcodeCountryScopeOf(tree: AddressTree): string | undefined {
	const stack: AddressNode[] = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!
		const scope = n.metadata?.["postcode_country_scope"] ?? n.metadata?.["explicit_country_scope"]

		if (typeof scope === "string" && scope.length) return scope

		stack.push(...n.children)
	}

	return undefined
}
