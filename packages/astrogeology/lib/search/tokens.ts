/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The half of the search artifact a browser reads: the tokenizer and the payload shape. The build and the app call
 *   the same function over a name and a query, so a builder and a reader that tokenize differently never meet. This
 *   module reaches no filesystem, so an app bundles it without the build behind it.
 */

import type { BuildableBodyID } from "#bodies"

/**
 * What a suggestion returns: enough to place and frame the feature without a second lookup.
 *
 * `diameterKm` lets a camera choose a zoom.
 * When it is absent, the framing function uses its smallest-feature branch.
 *
 * Every search result and deep link then frames a 4,000 km canyon as tightly as a 3 km crater.
 * `featureTypeCode` accompanies it for the same reason.
 *
 * A reader that has the feature should not need the tile to describe it.
 *
 * Both fields are optional because the IAU gazetteer leaves them unset for some features.
 * An absent diameter represents missing data, while zero represents a measured value.
 *
 * A type alias rather than an interface: the trie builder takes a `JSONValue`, and only an
 * alias has the implicit index signature that makes an optional property assignable to one.
 * An interface fails to assign once `diameterKm` is present.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- see the note above. an interface does not assign to `JSONValue`
export type NomenclatureSearchPayload = {
	id: string
	body: BuildableBodyID
	name: string
	featureType: string
	featureTypeCode?: string
	diameterKm?: number
	centerLon: number
	centerLat: number
}

/**
 * A name as the tokens the trie stores: lowercased, split on whitespace and hyphens, punctuation dropped.
 */
export function nomenclatureTokens(name: string): string[] {
	return name
		.toLowerCase()
		.split(/[\s-]+/u)
		.map((token) => token.replaceAll(/[^\p{L}\p{N}]/gu, ""))
		.filter((token) => token.length)
}
