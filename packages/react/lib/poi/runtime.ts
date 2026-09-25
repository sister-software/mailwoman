/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createKindClassifier } from "@mailwoman/kind-classifier"
import type { POIPhraseLookup } from "@mailwoman/kind-classifier"
import { createPOIBrandLookup, createPOITaxonomyLookup } from "@mailwoman/poi-taxonomy/table"

import type { POIRuntime } from "#poi/types"

/**
 * Loads the browser POI runtime, importing the taxonomy and brand tables dynamically
 * so they land in their own chunk instead of every consumer's bundle.
 *
 * Its lexicon tries exact categories and then brands only, a subset of the Node `poiTaxonomyLookup` chain.
 */
export async function loadPOIRuntime(): Promise<POIRuntime> {
	const [table, brandTable] = await Promise.all([
		import("@mailwoman/poi-taxonomy/data/taxonomy.json").then((m) => m.default),
		import("@mailwoman/poi-taxonomy/data/brands.json").then((m) => m.default),
	])

	const lookup = createPOITaxonomyLookup(table as Parameters<typeof createPOITaxonomyLookup>[0])
	const brands = createPOIBrandLookup(brandTable as Parameters<typeof createPOIBrandLookup>[0])

	const lexicon: POIPhraseLookup = (phrase, locale) => {
		const categoryHits = lookup.lookupPOICategory(phrase, locale)

		if (categoryHits.length) {
			return categoryHits.map((match) => ({
				kind: "category",
				categoryID: match.category.id,
				matchedPhrase: match.matchedPhrase,
				confidence: match.confidence,
			}))
		}

		return brands.lookupPOIBrand(phrase).map((match) => ({
			kind: "brand",
			categoryID: match.brand.name,
			wikidata: match.brand.wikidata,
			matchedPhrase: match.matchedPhrase,
			confidence: match.confidence,
		}))
	}

	return { lookup, lexicon, classify: createKindClassifier({ poiLexicon: lexicon }) }
}

/**
 * Default example queries for the POI explorer — a mix of category, build-local, and chain-brand subjects.
 */
export const POI_PRESETS = [
	{ label: "Drinking fountain", value: "drinking fountain near Springfield" },
	{ label: "Fire hydrant", value: "fire hydrant" },
	{ label: "Hospital + address", value: "hospital, 350 5th Ave, New York" },
	{ label: "Chevron (brand)", value: "chevron near Houston" },
	{ label: "Applebee's (brand)", value: "applebee's near Chicago" },
] as const

/**
 * Holds the query the POI explorer opens on, taken from the first preset so the two stay in step.
 */
export const POI_DEFAULT_TEXT = POI_PRESETS[0].value

/**
 * `742 m` under 1 km, `1.9 km` past it — matches the demo's distance captions.
 */
export function formatDistance(distanceM: number): string {
	if (distanceM < 1000) return `${Math.round(distanceM)} m`

	return `${(distanceM / 1000).toFixed(1)} km`
}
