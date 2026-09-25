/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the metadata stamps that resolver passes leave on a resolved tree's nodes.
 */

import { type AddressNode, type AddressTree, firstNodeWhere, walkNodes } from "@mailwoman/core/decoder"
import { countryFromPostcodeFormat } from "@mailwoman/core/resolver"

/**
 * Returns the uppercased first `resolver_country` stamp in the tree, or undefined when no node has one.
 */
export function resolvedCountryOf(tree: AddressTree): string | undefined {
	for (const n of walkNodes(tree.roots)) {
		const c = (n.metadata?.["resolver_country"] as string | undefined)?.trim()

		if (c) return c.toUpperCase()
	}

	return undefined
}

/**
 * Returns the promoted candidate's country from the `capital_promotion` stamp.
 *
 * It returns `"unknown"` for a stamp without a country, and `undefined`
 * when capital promotion changed no node's winner.
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
 * Returns `true` when the variant-alias exemption decided some node's winner, and `undefined` otherwise.
 */
export function variantAliasExemptionOf(tree: AddressTree): true | undefined {
	return firstNodeWhere(tree.roots, (n) => n.metadata?.["variant_alias_exemption"] === true) ? true : undefined
}

/**
 * Returns the country that a resolver pass scoped the walk to.
 *
 * It reads the `postcode_country_scope` stamp, then the `explicit_country_scope` stamp.
 * The explicit stamp lets a tree scoped correctly from the start still load its country's rooftop database.
 *
 * The function returns `undefined` when neither stamp is present.
 */
export function postcodeCountryScopeOf(tree: AddressTree): string | undefined {
	for (const n of walkNodes(tree.roots)) {
		const scope = n.metadata?.["postcode_country_scope"] ?? n.metadata?.["explicit_country_scope"]

		if (typeof scope === "string" && scope.length) return scope
	}

	return undefined
}

/**
 * Returns the value of the first `postcode` node in a parsed tree, or undefined.
 */
export function treePostcodeValue(tree: AddressTree): string | undefined {
	return firstNodeWhere(tree.roots, (node) => node.tag === "postcode")?.value
}

/**
 * Retags the tree's only valued node as `postcode` when its value is an unambiguous postcode.
 *
 * The model sometimes tags a bare postcode such as `N7 0BT` as a street,
 * and the resolver then finds no coordinate.
 * The retag applies only when all of these hold:
 *
 * - The tree has no `postcode` node.
 * - The node is the only node with a value.
 * - `countryFromPostcodeFormat` maps the value to a single country, as it does for GB, CA and IE formats.
 *
 * The function mutates the tree and returns it.
 */
export function recognizeBarePostcode(tree: AddressTree): AddressTree {
	const valued: AddressNode[] = []

	for (const n of walkNodes(tree.roots)) {
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
