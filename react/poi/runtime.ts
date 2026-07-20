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
import { createPOITaxonomyLookup } from "@mailwoman/poi-taxonomy/table"

import type { POIRuntime } from "./types.ts"

/**
 * Build the POI runtime, dynamically importing the taxonomy JSON so the ~2k-record table lands in its own chunk. A
 * static import would inline the whole snapshot into every consumer's bundle.
 */
export async function loadPOIRuntime(): Promise<POIRuntime> {
	const table = (await import("@mailwoman/poi-taxonomy/data/taxonomy.json")).default
	const lookup = createPOITaxonomyLookup(table as unknown as Parameters<typeof createPOITaxonomyLookup>[0])

	// Adapt `POITaxonomyLookup.lookupPOICategory` to the `POIPhraseLookup` shape the classifier expects.
	const lexicon: POIPhraseLookup = (phrase, locale) =>
		lookup.lookupPOICategory(phrase, locale).map((match) => ({
			kind: "category",
			categoryID: match.category.id,
			matchedPhrase: match.matchedPhrase,
			confidence: match.confidence,
		}))

	return { lookup, lexicon, classify: createKindClassifier({ poiLexicon: lexicon }) }
}

/** Default example queries for the POI explorer. */
export const POI_PRESETS = [
	{ label: "Drinking fountain", value: "drinking fountain near Springfield" },
	{ label: "Fire hydrant", value: "fire hydrant" },
	{ label: "Hospital + address", value: "hospital, 350 5th Ave, New York" },
	{ label: "Biking trails", value: "biking trails near Portland" },
] as const

export const POI_DEFAULT_TEXT = POI_PRESETS[0].value

/** `742 m` under 1 km, `1.9 km` past it — matches the demo's distance captions. */
export function formatDistance(distanceM: number): string {
	if (distanceM < 1000) return `${Math.round(distanceM)} m`

	return `${(distanceM / 1000).toFixed(1)} km`
}
