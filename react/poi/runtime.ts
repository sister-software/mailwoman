/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default POI runtime loader + presentation helpers. `loadPOIRuntime` dynamically imports the
 *   ~2k-record Overture taxonomy snapshot (so bundlers code-split it into its own chunk, fetched only
 *   when the explorer actually mounts) and wires the kind classifier over it. Pure + browser-safe: no
 *   network, no DOM — the whole intent path runs offline.
 */

import { createKindClassifier } from "@mailwoman/kind-classifier"
import type { POIPhraseLookup } from "@mailwoman/kind-classifier"
import { createPOIBrandLookup, createPOITaxonomyLookup } from "@mailwoman/poi-taxonomy/table"

import type { POIRuntime } from "./types.ts"

/**
 * Build the POI runtime, dynamically importing the taxonomy + brand JSON so the tables land in their own chunk. A
 * static import would inline the whole snapshot into every consumer's bundle.
 *
 * The lexicon unions categories then brands, mirroring the Node runtime's `poiTaxonomyLookup` precedence: a phrase that
 * matches a taxonomy CATEGORY wins (the curated set); only on a category miss does the chain-brand table fire,
 * returning a `kind: "brand"` match carrying the brand's canonical name + Wikidata QID. (The Node path also chains
 * `@mailwoman/variant-aliases` regional slang; the browser tester leaves that out — one fewer package + data table for
 * a demo, and the QID-keyed brand table already covers the headline brands.)
 */
export async function loadPOIRuntime(): Promise<POIRuntime> {
	const [table, brandTable] = await Promise.all([
		import("@mailwoman/poi-taxonomy/data/taxonomy.json").then((m) => m.default),
		import("@mailwoman/poi-taxonomy/data/brands.json").then((m) => m.default),
	])
	const lookup = createPOITaxonomyLookup(table as unknown as Parameters<typeof createPOITaxonomyLookup>[0])
	const brands = createPOIBrandLookup(brandTable as unknown as Parameters<typeof createPOIBrandLookup>[0])

	// Adapt the taxonomy + brand lookups to the `POIPhraseLookup` shape the classifier expects: categories first, brands
	// on a category miss.
	const lexicon: POIPhraseLookup = (phrase, locale) => {
		const categoryHits = lookup.lookupPOICategory(phrase, locale)

		if (categoryHits.length > 0) {
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

/** Default example queries for the POI explorer — a mix of category, build-local, and chain-brand subjects. */
export const POI_PRESETS = [
	{ label: "Drinking fountain", value: "drinking fountain near Springfield" },
	{ label: "Fire hydrant", value: "fire hydrant" },
	{ label: "Hospital + address", value: "hospital, 350 5th Ave, New York" },
	{ label: "Chevron (brand)", value: "chevron near Houston" },
	{ label: "Applebee's (brand)", value: "applebee's near Chicago" },
] as const

export const POI_DEFAULT_TEXT = POI_PRESETS[0].value

/** `742 m` under 1 km, `1.9 km` past it — matches the demo's distance captions. */
export function formatDistance(distanceM: number): string {
	if (distanceM < 1000) return `${Math.round(distanceM)} m`

	return `${(distanceM / 1000).toFixed(1)} km`
}
