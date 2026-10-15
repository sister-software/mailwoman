/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The anchor-region lookup over PFX1 postcode-prefix indexes. Each index states the prefix
 *   granularities it holds in its header's `levels`, so the lookup derives a postcode's prefix
 *   from the index rather than from the country, and the same module serves Node and the browser.
 */

import type { AnchorRegionAncestor, AnchorRegionLookupLike } from "@mailwoman/core/pipeline"
import type { PostcodePrefixNode } from "@mailwoman/core/resolver"

/**
 * The parts of a postcode-prefix index the anchor-region lookup reads.
 */
export interface AnchorRegionIndexLike {
	/**
	 * The ISO country code the index was built for, in either case.
	 */
	readonly country: string
	/**
	 * The prefix granularities the node table holds, such as `["3"]` or `["outward"]`.
	 */
	readonly levels: readonly string[]
	probe(prefix: string): PostcodePrefixNode | null
}

const GB_INWARD_LENGTH = 3

/**
 * Returns the prefix of `postcode` at one of an index's levels, or `null` when the code is too short.
 *
 * A numeric level is a leading digit count, as `"3"` for a US sectional center.
 * `"outward"` is a GB outward code, the unit postcode without its three-character inward part.
 */
export function prefixForLevel(postcode: string, level: string): string | null {
	const compact = postcode.replaceAll(/\s+/g, "").toUpperCase()

	if (level === "outward") {
		return compact.length > GB_INWARD_LENGTH ? compact.slice(0, -GB_INWARD_LENGTH) : null
	}

	const digits = Number.parseInt(level, 10)

	if (!Number.isInteger(digits) || digits <= 0) return null

	return compact.length >= digits ? compact.slice(0, digits) : null
}

/**
 * Returns an anchor-region lookup over postcode-prefix indexes.
 *
 * A postcode is probed in every index of its country, at each level the index holds,
 * and the first node found answers.
 * An empty answer means no index of that country holds the prefix.
 */
export function createAnchorRegionLookup(indexes: readonly AnchorRegionIndexLike[]): AnchorRegionLookupLike {
	return {
		ancestorsFor(postcode: string, country: string): readonly AnchorRegionAncestor[] {
			const wanted = country.toUpperCase()

			for (const index of indexes) {
				if (index.country.toUpperCase() !== wanted) continue

				for (const level of index.levels) {
					const prefix = prefixForLevel(postcode, level)
					const node = prefix ? index.probe(prefix) : null

					if (node) return node.ancestors
				}
			}

			return []
		},
	}
}
