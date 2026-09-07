/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Test/story mocks — a fake POI runtime, so the POI explorer exercises its full state machine with NO
 *   network, db, model, or taxonomy load. The fake geocoder runtime is a public subpath, `map/fake-runtime`. The shapes are cast through
 *   `unknown` because the real runtimes carry far more surface than these hooks touch.
 */

import type { CategoryRecord, POILiveSearch, POIRuntime, TaxonomyLookup } from "@mailwoman/react"

const DRINKING_FOUNTAIN = { id: "drinking_water", label: "Drinking Fountain" } as CategoryRecord

/**
 * A fake taxonomy-runtime that classifies everything as a POI query and matches "drinking fountain".
 */
export function makePOIRuntime(): POIRuntime {
	const lookup = {
		getPOICategory: (id: string) => (id === "drinking_water" ? DRINKING_FOUNTAIN : undefined),
		requiresBuildLocalLayer: () => false,
		resolveOvertureCategories: (id: string) => [id],
		lookupPOICategory: () => [],
		lookupPOICategoryLocaleNormalized: () => [],
		lookupPOICategoryTypo: () => [],
		getAllCategories: () => [],
	} as TaxonomyLookup

	return {
		lookup,
		lexicon: (phrase) =>
			phrase.trim().toLowerCase() === "drinking fountain"
				? [{ kind: "category", categoryID: "drinking_water", matchedPhrase: "drinking fountain", confidence: 0.9 }]
				: [],
		classify: async () => ({ kind: "poi_query", confidence: 0.9, alternatives: [] }),
	}
}

/**
 * A fake taxonomy-runtime that classifies everything as a POI query and matches "chevron" as a BRAND (QID Q319642). No
 * category record — brands carry a name + QID, not a taxonomy id.
 */
export function makeBrandPOIRuntime(): POIRuntime {
	const lookup = {
		getPOICategory: () => undefined,
		requiresBuildLocalLayer: () => false,
		resolveOvertureCategories: (id: string) => [id],
		lookupPOICategory: () => [],
		lookupPOICategoryLocaleNormalized: () => [],
		lookupPOICategoryTypo: () => [],
		getAllCategories: () => [],
	} as TaxonomyLookup

	return {
		lookup,
		lexicon: (phrase) =>
			phrase.trim().toLowerCase() === "chevron"
				? [{ kind: "brand", categoryID: "Chevron", wikidata: "Q319642", matchedPhrase: "chevron", confidence: 1 }]
				: [],
		classify: async () => ({ kind: "poi_query", confidence: 0.9, alternatives: [] }),
	}
}

/**
 * A live-search probe that always returns two hits near "Springfield, IL".
 */
export const mockLiveSearchSuccess: POILiveSearch = async () => ({
	status: "success",
	centerName: "Springfield, IL",
	hits: [
		{ name: "Washington Park Fountain", lat: 39.79, lon: -89.65, distanceM: 320, country: "US", confidence: 0.8 },
		{ name: "Lincoln Library Fountain", lat: 39.8, lon: -89.64, distanceM: 910, country: "US", confidence: 0.7 },
	],
})

/**
 * A live-search probe that echoes the brand QID it received back through the hits, so tests can assert the brand path
 * threaded `brandWikidata` (a category probe never sets it).
 */
export const mockBrandLiveSearchSuccess: POILiveSearch = async ({ brandWikidata }) => ({
	status: "success",
	centerName: "Houston, TX",
	hits: [
		{
			name: `Chevron (${brandWikidata ?? "no-qid"})`,
			lat: 29.76,
			lon: -95.37,
			distanceM: 210,
			country: "US",
			confidence: 0.9,
		},
		{ name: "Chevron", lat: 29.79, lon: -95.4, distanceM: 4200, country: "US", confidence: 0.85 },
	],
})
