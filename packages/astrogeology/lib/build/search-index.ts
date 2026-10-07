/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The search artifact: one `@mailwoman/ancestrie` entry per feature name, one more per alias, ranked by diameter so
 *   a larger feature sorts first at an equal prefix. The trie stores no ancestry (nomenclature has no containment
 *   graph). It gives the app a prefix walk over names with the feature's id and position as payload.
 *
 *   The tokenizer lives in `#search/tokens`, the platform-free half an app bundles. the build calls the same one.
 */

import { AncestrieBuilder } from "@mailwoman/ancestrie"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { isoSeconds } from "@mailwoman/core/utils"

import type { PlanetaryNomenclatureFeature } from "#schema/nomenclature"
import { type NomenclatureSearchPayload, nomenclatureTokens } from "#search/tokens"

/**
 * Build the search artifact over the features and write it to `outPath`.
 *
 * Answers the entry count.
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
			// A missing diameter stays null.
			// A zero diameter would tell a camera that a feature with no diameter is a point.
			featureTypeCode: feature.featureTypeCode || null,
			diameterKm: feature.diameterKm,
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
