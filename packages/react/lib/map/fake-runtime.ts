/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"

import type { ResolvedMapPlace } from "#map/place-render"
import type { GeocoderRuntime, Suggestion } from "#map/types"
import type { PipelineRuntime } from "#pipeline/types"

import type { MapCanvasStyle } from "./MapCanvas.tsx"

/**
 * Defines an offline map style with a single background layer and no sources,
 * so it renders in headless Storybook without network access.
 */
export const STUB_MAP_STYLE: MapCanvasStyle = {
	version: 8,
	name: "demo-runtime-stub",
	sources: {},
	layers: [{ id: "background", type: "background", paint: { "background-color": "#dfe7ee" } }],
}

/**
 * Canned place-autocomplete suggestions — a synchronous fake for the FST prefix-walk.
 */
export const FAKE_SUGGESTIONS: Suggestion[] = [
	{ value: "New York", placetype: "locality" },
	{ value: "New Orleans", placetype: "locality" },
	{ value: "Newark", placetype: "locality" },
]

/**
 * Creates an offline {@link GeocoderRuntime} that extends {@link makePipelineRuntime}
 * with the stub style, canned suggestions and versions, and a `resolveMapPlace`
 * that gives the candidate a bounding box so overlays draw.
 * The fake ignores the bias passed to `runParseWithBias`.
 */
export function makeFakeGeocoderRuntime(overrides: Partial<GeocoderRuntime> = {}): GeocoderRuntime {
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

/**
 * Creates a fixed, fully populated parse-and-resolve result for the given input,
 * shared by the fake pipeline runtime and result-panel fixtures.
 */
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
		resolved: { id: 85_977_539, name: "New York", placetype: "locality", lat: 40.7128, lon: -74.006, score: 0.82 },
		candidates: [
			{ id: 85_977_539, name: "New York", placetype: "locality", lat: 40.7128, lon: -74.006, score: 0.82 },
			{ id: 101_715_829, name: "New York", placetype: "region", lat: 43, lon: -75, score: 0.55 },
		],
		fstActive: true,
		fstProvenance: { builtAt: "2026-07-01T00:00:00Z", stateCount: 51, placeCount: 94_000, importanceMatches: 12_000 },
	}
}

/**
 * A fake parse+resolve runtime that returns a fixed, fully-populated result.
 */
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
