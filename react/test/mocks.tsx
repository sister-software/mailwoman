/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Test/story mocks — a fake POI runtime and a fake pipeline runtime, so the explorers exercise their
 *   full state machines with NO network, db, model, or taxonomy load. The shapes are cast through
 *   `unknown` because the real runtimes carry far more surface than these hooks touch.
 */

import type { CategoryRecord, POILiveSearch, POIRuntime, TaxonomyLookup } from "../index.ts"
import type { ParseResult, PipelineRuntime } from "../index.ts"

const DRINKING_FOUNTAIN = { id: "drinking_water", label: "Drinking Fountain" } as unknown as CategoryRecord

/** A fake taxonomy-runtime that classifies everything as a POI query and matches "drinking fountain". */
export function makePOIRuntime(): POIRuntime {
	const lookup = {
		getPOICategory: (id: string) => (id === "drinking_water" ? DRINKING_FOUNTAIN : undefined),
		requiresBuildLocalLayer: () => false,
		resolveOvertureCategories: (id: string) => [id],
		lookupPOICategory: () => [],
	} as unknown as TaxonomyLookup

	return {
		lookup,
		lexicon: (phrase) =>
			phrase.trim().toLowerCase() === "drinking fountain"
				? [{ kind: "category", categoryID: "drinking_water", matchedPhrase: "drinking fountain", confidence: 0.9 }]
				: [],
		classify: async () => ({ kind: "poi_query", confidence: 0.9, alternatives: [] }),
	}
}

/** A live-search probe that always returns two hits near "Springfield, IL". */
export const mockLiveSearchSuccess: POILiveSearch = async () => ({
	status: "success",
	centerName: "Springfield, IL",
	hits: [
		{ name: "Washington Park Fountain", lat: 39.79, lon: -89.65, distanceM: 320, country: "US", confidence: 0.8 },
		{ name: "Lincoln Library Fountain", lat: 39.8, lon: -89.64, distanceM: 910, country: "US", confidence: 0.7 },
	],
})

/** A fake parse+resolve runtime that returns a fixed, fully-populated result. */
export function makePipelineRuntime(overrides: Partial<PipelineRuntime> = {}): PipelineRuntime {
	return {
		ready: true,
		parseStageLabels: ["Analyzing input shape…", "Running neural classifier…", "Resolving in gazetteer…"],
		errorMessage: null,
		loading: null,
		runParse: async (input, { onStage }): Promise<ParseResult> => {
			onStage(1)
			onStage(2)

			return {
				input,
				tree: { roots: [{ tag: "locality", value: "New York" }] },
				nodes: [
					{ tag: "house_number", value: "350", confidence: 0.97, start: 0, end: 3 },
					{ tag: "street", value: "5th Ave", confidence: 0.88, start: 4, end: 11 },
					{ tag: "locality", value: "New York", confidence: 0.71 },
				],
				kindResult: { kind: "structured_address", confidence: 0.95, alternatives: [] },
				timing: { shape: 0.4, classify: 12.1, resolve: 4.2 },
				resolved: { id: 85977539, name: "New York", placetype: "locality", lat: 40.7128, lon: -74.006, score: 0.82 },
				candidates: [
					{ id: 85977539, name: "New York", placetype: "locality", lat: 40.7128, lon: -74.006, score: 0.82 },
					{ id: 101715829, name: "New York", placetype: "region", lat: 43.0, lon: -75.0, score: 0.55 },
				],
				fstActive: true,
				fstProvenance: { builtAt: "2026-07-01T00:00:00Z", stateCount: 51, placeCount: 94000, importanceMatches: 12000 },
			}
		},
		...overrides,
	}
}
