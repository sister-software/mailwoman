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
 * What a suggestion carries back: enough to place the feature without a second lookup.
 */
export interface NomenclatureSearchPayload {
	id: string
	body: BuildableBodyID
	name: string
	featureType: string
	centerLon: number
	centerLat: number
	[key: string]: string | number
}

/**
 * A name as the tokens the trie stores: lowercased, split on whitespace and hyphens, punctuation dropped.
 */
export function nomenclatureTokens(name: string): string[] {
	return name
		.toLowerCase()
		.split(/[\s-]+/u)
		.map((token) => token.replaceAll(/[^\p{L}\p{N}]/gu, ""))
		.filter((token) => token.length > 0)
}
