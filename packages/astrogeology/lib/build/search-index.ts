/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The search artifact: one `@mailwoman/ancestrie` entry per feature name, one more per alias, ranked by diameter so
 *   a larger feature sorts first at an equal prefix. The trie carries no ancestry (nomenclature has no containment
 *   graph); what it gives the app is a prefix walk over the names with the feature's id and position as cargo.
 *
 *   The tokenizer is exported and the app calls the same one over the query: the package never normalizes on its own,
 *   so a builder and a reader that tokenize differently never meet.
 */

import { AncestrieBuilder } from "@mailwoman/ancestrie"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { isoSeconds } from "@mailwoman/core/utils"

import type { BuildableBodyID } from "#bodies"
import type { PlanetaryNomenclatureFeature } from "#schema/nomenclature"

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
 * A name as the tokens the trie stores: lowercased, split on whitespace and hyphens, punctuation dropped. The app
 * tokenizes a query with this same function.
 */
export function nomenclatureTokens(name: string): string[] {
	return name
		.toLowerCase()
		.split(/[\s-]+/u)
		.map((token) => token.replaceAll(/[^\p{L}\p{N}]/gu, ""))
		.filter((token) => token.length > 0)
}

/**
 * Build the search artifact over the features and write it to `outPath`. Answers the entry count.
 */
export async function buildSearchIndex(
	features: Iterable<PlanetaryNomenclatureFeature>,
	outPath: string
): Promise<number> {
	const builder = new AncestrieBuilder({ normalizeToken: (token) => token })
	let entries = 0

	for (const feature of features) {
		const payload: NomenclatureSearchPayload = {
			id: feature.id,
			body: feature.body,
			name: feature.name,
			featureType: feature.featureType,
			centerLon: feature.centerLon,
			centerLat: feature.centerLat,
		}

		const surfaces = new Set([feature.name, feature.cleanName ?? feature.name])

		for (const surface of surfaces) {
			const tokens = nomenclatureTokens(surface)

			if (!tokens.length) continue

			builder.add({ tokens, id: Number(feature.id), parentIDs: [], rank: feature.diameterKm ?? 0, payload })

			entries++
		}
	}

	await writeLocalFile(builder.seal({ metadata: { builtAt: isoSeconds() } }), outPath)

	return entries
}
