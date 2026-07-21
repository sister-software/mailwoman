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
import type { DemoMapStyle, DemoRuntime, ParseResult, PipelineRuntime, Suggestion } from "../index.ts"
import type { ResolvedMapPlace } from "../map/place-render.ts"

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
	} as unknown as TaxonomyLookup

	return {
		lookup,
		lexicon: (phrase) =>
			phrase.trim().toLowerCase() === "chevron"
				? [{ kind: "brand", categoryID: "Chevron", wikidata: "Q319642", matchedPhrase: "chevron", confidence: 1 }]
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

/** An offline stub map style — one solid `background` layer, zero sources, zero network. Safe for headless Storybook. */
export const STUB_MAP_STYLE: DemoMapStyle = {
	version: 8,
	name: "demo-runtime-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/** Canned place-autocomplete suggestions — a synchronous fake for the FST prefix-walk. */
export const FAKE_SUGGESTIONS: Suggestion[] = [
	{ value: "New York", placetype: "locality" },
	{ value: "New Orleans", placetype: "locality" },
	{ value: "Newark", placetype: "locality" },
]

/**
 * A fake DEMO runtime — the map analogue of {@link makePipelineRuntime}. It composes the pipeline fake (canned
 * parse+resolve) with the map surface: the offline stub style, a version list, a backend, an injected autocomplete, and
 * a `resolveMapPlace` that hands the selected candidate a bbox so the declarative overlays draw a marker + outline. No
 * network, no ONNX, no maplibre-at-runtime — everything is data. `runParseWithBias` delegates to the base parse (the
 * bias is ignored by the fake but present so the seam is exercised).
 */
export function makeDemoRuntime(overrides: Partial<DemoRuntime> = {}): DemoRuntime {
	const base = makePipelineRuntime()

	return {
		...base,
		mapStyle: STUB_MAP_STYLE,
		initialCenter: [-74.006, 40.7128],
		initialZoom: 3,
		overlays: [],
		runParseWithBias: (input, _bias, hooks) => base.runParse(input, hooks),
		autocomplete: async (query: string) =>
			FAKE_SUGGESTIONS.filter((s) => s.value.toLowerCase().startsWith(query.toLowerCase())),
		availableVersions: [
			{ version: "v7.2.0", label: "v7.2.0 (latest)" },
			{ version: "v7.1.0", label: "v7.1.0" },
			{ version: "v6.4.0", label: "v6.4.0" },
		],
		selectedVersion: "v7.2.0",
		selectVersion: () => {},
		activeBackend: "webgpu (28 MB int8)",
		forceWASM: false,
		setForceWASM: () => {},
		// Enrich the selected candidate with a bbox so an outline renders (case 4: bbox → approximate circle + fit).
		resolveMapPlace: (candidate): ResolvedMapPlace => ({
			...candidate,
			bbox: {
				minLat: candidate.lat - 0.15,
				maxLat: candidate.lat + 0.15,
				minLon: candidate.lon - 0.15,
				maxLon: candidate.lon + 0.15,
			},
		}),
		...overrides,
	}
}

/** A fixed, fully-populated parse+resolve result — the shared fixture behind the pipeline runtime + the result panel. */
export function makeFakeParseResult(input = "350 5th Ave, New York, NY 10118"): ParseResult {
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
}

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

			return makeFakeParseResult(input)
		},
		...overrides,
	}
}
