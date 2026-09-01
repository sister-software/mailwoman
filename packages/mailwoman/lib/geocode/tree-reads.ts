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

import { type AddressNode, type AddressTree, firstNodeWhere, walkNodes } from "@mailwoman/core/decoder"
import { countryFromPostcodeFormat } from "@mailwoman/core/resolver"

/**
 * The resolved tree's own country — the first `resolver_country` stamp on any node (constant across one address's
 * resolved nodes), or undefined when nothing resolved with one. The rooftop second pass keys on this.
 */
export function resolvedCountryOf(tree: AddressTree): string | undefined {
	for (const n of walkNodes(tree.roots)) {
		const c = (n.metadata?.["resolver_country"] as string | undefined)?.trim()

		if (c) return c.toUpperCase()
	}

	return undefined
}

/**
 * The #1880 capital promotion's stamp, read back off the resolved tree — the promoted candidate's country, or
 * `undefined` when no node's race was reordered by it.
 */
export function capitalPromotionOf(tree: AddressTree): string | undefined {
	for (const n of walkNodes(tree.roots)) {
		const stamp = n.metadata?.["capital_promotion"]

		if (typeof stamp === "string" && stamp.length) return stamp

		if (stamp === true) return "unknown"
	}

	return undefined
}

/**
 * The #1882 variant-alias exemption's stamp (#1893), read back off the resolved tree — `true` when some node's winning
 * candidate reached the top because the exemption spared it the cross-country alias penalty, `undefined` when it never
 * spoke: off, no variant row in any race, the variant lost, or a backend that never runs the ranker.
 */
export function variantAliasExemptionOf(tree: AddressTree): true | undefined {
	return firstNodeWhere(tree.roots, (n) => n.metadata?.["variant_alias_exemption"] === true) ? true : undefined
}

/**
 * The country #42's postcode-country coherence pass scoped the walk to, read back off the resolved tree's
 * `postcode_country_scope` stamp — or the #1735 explicit-country pre-scope, whose receipt exists precisely so a tree
 * that was right from the start still gets its country's rooftop database loaded. `undefined` whenever nothing was
 * overridden.
 */
export function postcodeCountryScopeOf(tree: AddressTree): string | undefined {
	for (const n of walkNodes(tree.roots)) {
		const scope = n.metadata?.["postcode_country_scope"] ?? n.metadata?.["explicit_country_scope"]

		if (typeof scope === "string" && scope.length) return scope
	}

	return undefined
}

/**
 * The first `postcode` node's value in a parsed tree, or undefined.
 */
export function treePostcodeValue(tree: AddressTree): string | undefined {
	return firstNodeWhere(tree.roots, (node) => node.tag === "postcode")?.value
}

/**
 * Retag a WHOLE-INPUT span the model read as something else when the string is an unambiguous postcode — the
 * bare-postcode class (#22).
 *
 * `mailwoman geocode --locale en-GB "N7 0BT"` parses to `{ street: "N7 0BT" }` and returns no coordinate, while the
 * same code inside a full address (`… London, N7 0BT`) parses as a postcode and resolves to a point 38 m from the
 * rooftop. Nothing downstream can recover it: the walk only looks up a `postcode` node, and span-rescore's
 * confident-constituent guard treats the street span as un-recoverable material (correctly — that guard is what stops
 * "Ave" resolving to Ave, France).
 *
 * The gate is deliberately the narrowest one that fixes the class:
 *
 * - The tree carries NO postcode node already (never second-guess a parse that found one),
 * - The retagged node is the ONLY value-bearing node in the tree, and
 * - Its value matches a format that is UNFORGEABLE across the systems we resolve ({@link POSTCODE_FORMAT_COUNTRY} —
 *   GB/CA/IE, the same table #928 already trusts to name a country outright).
 *
 * So it fires on `N7 0BT` and `K2P 1L4` and on nothing that is also a plausible street, venue or city name. A US ZIP is
 * out of scope by construction: `90210` alone is five digits, which the model already tags `postcode`, and the format
 * table would not distinguish it from a DE PLZ anyway.
 *
 * Mutates and returns the tree (same posture as `recognizeUSRegions`).
 */
export function recognizeBarePostcode(tree: AddressTree): AddressTree {
	const valued: AddressNode[] = []

	for (const n of walkNodes(tree.roots)) {
		// The parse already found a postcode — never second-guess it.
		if (n.tag === "postcode") return tree

		if (n.value.trim().length) {
			valued.push(n)
		}
	}

	if (valued.length !== 1) return tree
	const only = valued[0]!

	if (!countryFromPostcodeFormat(only.value)) return tree
	only.tag = "postcode"

	only.metadata = { ...only.metadata, bare_postcode_retag: true }

	return tree
}
