// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads the metadata stamps that resolver passes leave on a resolved tree's nodes.
 */

import { type AddressTree, firstNodeWhere, walkNodes } from "@mailwoman/core/decoder"
import type { VariantAliasExemption } from "@mailwoman/core/geocode"

/**
 * Returns the uppercased first `resolver_country` stamp in the tree, or null when no node has one.
 */
export function resolvedCountryOf(tree: AddressTree): string | null {
	for (const n of walkNodes(tree.roots)) {
		const c = (n.metadata?.["resolver_country"] as string | undefined)?.trim()

		if (c) return c.toUpperCase()
	}

	return null
}

/**
 * Returns the promoted candidate's country from the `capital_promotion` stamp.
 *
 * It returns `"unknown"` for a stamp without a country.
 * It returns `null` when capital promotion changed no node's winner.
 */
export function capitalPromotionOf(tree: AddressTree): string | null {
	for (const n of walkNodes(tree.roots)) {
		const stamp = n.metadata?.["capital_promotion"]

		if (typeof stamp === "string" && stamp) return stamp

		if (stamp === true) return "unknown"
	}

	return null
}

/**
 * Returns `applied` when the variant-alias exemption selected a node's winner, and `not_applied` otherwise.
 */
export function variantAliasExemptionOf(tree: AddressTree): VariantAliasExemption {
	return firstNodeWhere(tree.roots, (n) => n.metadata?.["variant_alias_exemption"] === true) ? "applied" : "not_applied"
}

/**
 * Returns the country that a resolver pass scoped the walk to.
 *
 * It reads the `postcode_country_scope` stamp, then the `explicit_country_scope` stamp.
 * The explicit stamp lets a tree scoped correctly from the start still load its country's rooftop database.
 *
 * The function returns `null` when neither stamp is present.
 */
export function postcodeCountryScopeOf(tree: AddressTree): string | null {
	for (const n of walkNodes(tree.roots)) {
		const scope = n.metadata?.["postcode_country_scope"] ?? n.metadata?.["explicit_country_scope"]

		if (typeof scope === "string" && scope) return scope
	}

	return null
}

/**
 * Returns the value of the first `postcode` node in a parsed tree, or null.
 */
export function treePostcodeValue(tree: AddressTree): string | null {
	return firstNodeWhere(tree.roots, (node) => node.tag === "postcode")?.value ?? null
}
