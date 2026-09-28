/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the geocoder map surface; its `react-map-gl/maplibre` imports are type-only, so the module stays node-safe.
 */

import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"
import type { LayerSpecification, MapInstance, SourceSpecification } from "react-map-gl/maplibre"

import type { LngLat, ResolvedMapPlace } from "#map/place-render"
import type { PipelineRuntime } from "#pipeline/types"

import type { MapCanvasStyle } from "./MapCanvas.tsx"

/**
 * An alias for {@link LngLat}.
 *
 * @deprecated Alias kept for existing imports — {@link LngLat} (from `@mailwoman/react/map`) is the canonical name.
 */
export type LngLatTuple = LngLat

/**
 * A viewport bias handed to `runParse` — the map's current center (and optionally zoom) as a soft prior.
 */
export interface MapBias {
	center: LngLat
	zoom?: number
}

/**
 * A host-supplied overlay: one map `<Source>` plus one or more `<Layer>`s laid over the basemap.
 */
export interface OverlaySpec {
	/**
	 * Stable id — used as the `<Source>` id and the layer-id prefix.
	 */
	id: string
	source: SourceSpecification
	layers: LayerSpecification[]
	/**
	 * @default true
	 */
	visible?: boolean
	label?: string
}

/**
 * One autocomplete suggestion produced by the host's FST prefix-walk.
 */
export interface Suggestion {
	/**
	 * The text inserted when the suggestion is picked.
	 */
	value: string
	/**
	 * Optional display label if it differs from `value`.
	 */
	label?: string
	/**
	 * Optional place kind for badge/icon rendering.
	 */
	placetype?: string
}

/**
 * A selectable model bundle (version tag + a display label the picker shows).
 */
export interface VersionOption {
	/**
	 * The version tag, such as a git tag or model-card version.
	 */
	version: string
	/**
	 * Display label; the picker falls back to `version`.
	 */
	label?: string
}

/**
 * Which neural backend the geocoder is currently running on.
 */
export type InferenceBackend = "webgpu" | "wasm"

/**
 * The injected geocoder runtime, which extends {@link PipelineRuntime} with the map and version/backend surface.
 *
 * The package imports no `@mailwoman/cartographer`, `@mailwoman/neural` web loader, httpvfs, or Docusaurus.
 */
export interface GeocoderRuntime extends PipelineRuntime {
	/**
	 * The composed basemap style (URL or `StyleSpecification`).
	 */
	mapStyle: MapCanvasStyle
	overlays?: OverlaySpec[]
	/**
	 * Initial map center as `[lon, lat]`.
	 */
	initialCenter: LngLat
	initialZoom?: number

	/**
	 * A bias-aware parse that feeds the current viewport center as a soft prior; absent, the host falls back to {@link PipelineRuntime.runParse}.
	 */
	runParseWithBias?: (
		input: string,
		bias: MapBias | null,
		hooks: { onStage: (stage: number) => void }
	) => ReturnType<PipelineRuntime["runParse"]>
	/**
	 * FST prefix-walk autocomplete, wrapped by the host.
	 */
	autocomplete?: (query: string) => Promise<Suggestion[]>
	/**
	 * Maps a raw model score to a calibrated one; `null` when no calibration table is loaded.
	 */
	calibrator?: (raw: number) => number | null
	/**
	 * Enrich the selected candidate into the richer {@link ResolvedMapPlace} the declarative
	 * map render consumes (bbox, street tier + uncertainty, a pre-fetched crisp polygon) —
	 * the fields that live on the host's `ResolvedHit` but not on the shared {@link ResolvedPlaceView}.
	 *
	 * The host owns this because those extras (and the async polygon fetch in the real runtime)
	 * are host/gazetteer concerns.
	 * The package keeps {@link ParseResult} unpolluted.
	 *
	 * Absent → the candidate renders as a bare point (marker + a mid-zoom fly-to).
	 *
	 * Returning `null` also renders no overlay.
	 */
	resolveMapPlace?: (candidate: ResolvedPlaceView, result: ParseResult) => ResolvedMapPlace | null

	// ── Version + backend selection ─────────────────────────────────────────
	/**
	 * The selectable model bundles the version picker offers.
	 */
	availableVersions?: VersionOption[]
	selectedVersion?: string
	/**
	 * Switch the active model bundle (re-loads weights/tokenizer/gazetteer).
	 */
	selectVersion?: (version: string) => void
	/**
	 * The backend the neural runtime resolved to (e.g. `webgpu (28 MB int8)`); free-form for the label.
	 */
	activeBackend?: string
	/**
	 * Whether the CPU/wasm backend is currently forced (the controlled value for the backend toggle).
	 */
	forceWASM?: boolean
	/**
	 * Force the wasm backend (opt out of WebGPU), for the backend toggle.
	 */
	setForceWASM?: (forceWASM: boolean) => void
}

/**
 * The compare-mode state a {@link GeocoderPanels.compare} render-prop receives; the second parse itself stays host-side.
 */
export interface CompareContext {
	/**
	 * The current primary parse result, or `null` before the first submit.
	 */
	result: ParseResult | null
	compareMode: boolean
	/**
	 * The version selected to compare against, or `null` when none is chosen.
	 */
	compareVersion: string | null
}

/**
 * The state a {@link GeocoderPanels.result} render-prop receives, so a host can render its own result block; the candidate-selection state stays owned by the package (`useGeocode`).
 */
export interface ResultContext {
	result: ParseResult
	/**
	 * The selected candidate (falls back to the first), enriched for the resolved-place detail.
	 */
	selectedCandidate: ResolvedPlaceView | null
	selectedCandidateIndex: number
	onSelectCandidate: (index: number) => void
}

/**
 * Host-injected panels for {@link Geocoder}, the map analogue of `PipelinePanels`; each is an already-rendered `ReactNode` or a thunk, and every field is optional.
 */
export interface GeocoderPanels {
	/**
	 * Rendered at the top of the control panel, such as the host's "About this geocoder".
	 */
	header?: ReactNode
	/**
	 * One-line release blurb for the selected version.
	 */
	releaseInfo?: ReactNode
	/**
	 * Rendered at the bottom of the control panel, such as a guided tour.
	 */
	footer?: ReactNode
	/**
	 * A device-location / proximity-bias control, rendered between the query form and the autocomplete list; host-owned because the geolocation permission feeds {@link GeocoderRuntime.runParseWithBias}.
	 */
	bias?: ReactNode
	/**
	 * Heavy visualizers (span highlight, tree, timing, BIO, …), rendered from the result.
	 */
	extras?: (result: ParseResult) => ReactNode
	/**
	 * Rendered just above the result block for content that reads on this answer; a control that reads on the model belongs in {@link developerExtras}.
	 */
	aboveResult?: (context: { result: ParseResult | null }) => ReactNode
	/**
	 * Host controls appended to the Developer sheet — the opt-in display toggles, whose state and renderers belong to the host.
	 */
	developerExtras?: ReactNode
	/**
	 * Replaces the package's default {@link ResultPanel}; absent → the built-in panel renders, and when provided the host renders from {@link ResultContext}.
	 */
	result?: (context: ResultContext) => ReactNode
	/**
	 * Rendered in place of the resolved-place panel when no place resolved; ignored when {@link result} is set.
	 */
	failure?: (result: ParseResult) => ReactNode
	/**
	 * The version-compare view — the host renders its own diff from the compare state it owns.
	 */
	compare?: (context: CompareContext) => ReactNode
	/**
	 * The model-visualizer / debug drawer mounted beside the map, as a render-prop receiving the live result and returning `null` when closed.
	 */
	debugDrawer?: (context: { result: ParseResult | null }) => ReactNode
	/**
	 * Extra map controls mounted as `<MapCanvas>` children (host's DebugControl / LayerToggle via `useControl`).
	 */
	mapControls?: ReactNode
	/**
	 * A layer control rendered in the chrome's top column, as a render-prop over the live map handle (null until the map instantiates).
	 */
	layers?: (context: { map: MapInstance | null }) => ReactNode
	/**
	 * A permalink control for the current address (host's PermalinkButton).
	 */
	permalink?: (text: string) => ReactNode
}
