/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the geocoder map surface. Mirrors the pipeline boundary: the package owns the UI state
 *   machine + the declarative map, while the host injects a {@link GeocoderRuntime} that owns ONNX / httpvfs
 *   / R2 and the composed map style. {@link GeocoderRuntime} EXTENDS {@link PipelineRuntime} so the shared
 *   `runParse` / `parseStageLabels` / `loading` contract is reused, and adds the map-specific surface
 *   (style, overlays, initial center, viewport bias, backend/version selection). Phase 4 adds the
 *   `resolveMapPlace` enricher, the {@link GeocoderPanels} injection bag, and the {@link CompareContext}.
 *
 *   The map-spec types are imported type-only from `react-map-gl/maplibre`; nothing here loads maplibre at
 *   runtime, so this module stays node-safe (its concrete-value CONSUMERS — `MapCanvas`, `Geocoder` —
 *   are the ones behind the `@mailwoman/react/map` subpath).
 */

import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"
import type { LayerSpecification, MapInstance, SourceSpecification } from "react-map-gl/maplibre"

import type { LngLat, ResolvedMapPlace } from "#map/place-render"
import type { PipelineRuntime } from "#pipeline/types"

import type { MapCanvasStyle } from "./MapCanvas.tsx"

/**
 * `[longitude, latitude]`.
 *
 * @deprecated Alias kept for existing imports — {@link LngLat} (from `@mailwoman/react/map`) is the canonical name.
 */
export type LngLatTuple = LngLat

/**
 * A viewport bias handed to `runParse` — the map's current center (and optionally zoom) as a soft prior.
 */
export interface MapBias {
	/**
	 * Map center as `[lon, lat]`, typically read from `map.getCenter()`.
	 */
	center: LngLat
	/**
	 * Current zoom, if the host wants distance-aware biasing.
	 */
	zoom?: number
}

/**
 * A host-supplied overlay: one map `<Source>` plus one or more `<Layer>`s laid over the basemap (coverage "fog of war",
 * race-dots, …). The host composes the specs; the package renders them declaratively in a later phase.
 */
export interface OverlaySpec {
	/**
	 * Stable id — used as the `<Source>` id and the layer-id prefix.
	 */
	id: string
	/**
	 * The map source spec (vector/geojson/raster).
	 */
	source: SourceSpecification
	/**
	 * The layers drawn from that source.
	 */
	layers: LayerSpecification[]
	/**
	 * Whether the overlay is visible initially. @default true
	 */
	visible?: boolean
	/**
	 * Human label for a layer-toggle control.
	 */
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
	 * The version tag (e.g. a git tag or model-card version).
	 */
	version: string
	/**
	 * Display label; falls back to `version`.
	 */
	label?: string
}

/**
 * Which neural backend the geocoder is currently running on.
 */
export type InferenceBackend = "webgpu" | "wasm"

/**
 * The injected geocoder runtime. Extends {@link PipelineRuntime} (shared `runParse` / `parseStageLabels` / `loading` /
 * `ready`) with the map + version/backend surface the geocoder needs. The host composes `mapStyle` (via cartographer's
 * `StyleSpecificationComposer` + the tile-worker TileJSON), supplies the overlay specs, the initial center (from
 * geolocation), the FST autocomplete, and the calibrator — nothing in the package imports `@mailwoman/cartographer`,
 * `@mailwoman/neural`'s web loader, httpvfs, or Docusaurus.
 */
export interface GeocoderRuntime extends PipelineRuntime {
	// ── Map ────────────────────────────────────────────────────────────────
	/**
	 * The composed basemap style (URL or `StyleSpecification`).
	 */
	mapStyle: MapCanvasStyle
	/**
	 * Host-supplied overlays (coverage, race-dots, …).
	 */
	overlays?: OverlaySpec[]
	/**
	 * Initial map center as `[lon, lat]` (the host's browser-geolocation result).
	 */
	initialCenter: LngLat
	/**
	 * Initial zoom for the first camera.
	 */
	initialZoom?: number

	// ── Parse extras layered over PipelineRuntime.runParse ──────────────────
	/**
	 * A bias-aware parse. The geocoder feeds the current viewport center as a soft prior; when absent the host falls back
	 * to the base {@link PipelineRuntime.runParse}. Kept separate so the shared `runParse` contract is unchanged.
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
	 * Enrich the selected candidate into the richer {@link ResolvedMapPlace} the declarative map render consumes (bbox,
	 * street tier + uncertainty, a pre-fetched crisp polygon) — the fields that live on the host's `ResolvedHit` but not
	 * on the shared {@link ResolvedPlaceView}. The host owns this because those extras (and the async polygon fetch in the
	 * real runtime) are host/gazetteer concerns; the package keeps {@link ParseResult} unpolluted. Absent → the candidate
	 * renders as a bare point (marker + a mid-zoom fly-to). Returning `null` also renders nothing.
	 */
	resolveMapPlace?: (candidate: ResolvedPlaceView, result: ParseResult) => ResolvedMapPlace | null

	// ── Version + backend selection ─────────────────────────────────────────
	/**
	 * The selectable model bundles the version picker offers.
	 */
	availableVersions?: VersionOption[]
	/**
	 * The currently-selected model version.
	 */
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
	 * Whether the CPU/WASM backend is currently forced (the controlled value for the backend toggle).
	 */
	forceWASM?: boolean
	/**
	 * Force the WASM backend (opt out of WebGPU), for the backend toggle.
	 */
	setForceWASM?: (forceWASM: boolean) => void
}

/**
 * The compare-mode state a {@link GeocoderPanels.compare} render-prop receives (the second parse itself stays
 * host-side).
 */
export interface CompareContext {
	/**
	 * The current primary parse result, or `null` before the first submit.
	 */
	result: ParseResult | null
	/**
	 * Whether the compare toggle is on.
	 */
	compareMode: boolean
	/**
	 * The version selected to compare against, or `null` when none is chosen.
	 */
	compareVersion: string | null
}

/**
 * The state a {@link GeocoderPanels.result} render-prop receives, so a host can render its OWN result block (a
 * `<ResultPanel>` with its span-highlight / timing / hierarchy / precision detail) in place of the package's default
 * {@link ResultPanel}. Everything the default panel needs is passed through; the candidate-selection state stays owned
 * by the package (`useGeocode`).
 */
export interface ResultContext {
	/**
	 * The current parse+resolve result.
	 */
	result: ParseResult
	/**
	 * The selected candidate (falls back to the first), enriched for the resolved-place detail.
	 */
	selectedCandidate: ResolvedPlaceView | null
	/**
	 * The selected candidate index, for the picker's active state.
	 */
	selectedCandidateIndex: number
	/**
	 * Fired when a candidate in the picker is chosen.
	 */
	onSelectCandidate: (index: number) => void
}

/**
 * Host-injected panels for {@link Geocoder}, the map analogue of `PipelinePanels`. Each is an already-rendered
 * `ReactNode` (or a thunk of the parse result / compare state) so the package needs neither the heavy host visualizers
 * (ModelVisualizer, VersionCompare, About, PermalinkButton) nor their data types. Every field is optional — the
 * fake-runtime Storybook stories pass none and still render the whole geocoder.
 */
export interface GeocoderPanels {
	/**
	 * Rendered at the top of the control panel (e.g. the host's "About this geocoder").
	 */
	header?: ReactNode
	/**
	 * One-line release blurb for the selected version.
	 */
	releaseInfo?: ReactNode
	/**
	 * Rendered at the bottom of the control panel (e.g. a guided tour).
	 */
	footer?: ReactNode
	/**
	 * A device-location / proximity-bias control, rendered between the query form and the autocomplete list (the "📍 Use
	 * my location" row). Host-owned so the geolocation permission + the bias it feeds into the host's
	 * {@link GeocoderRuntime.runParseWithBias} stay a host concern.
	 */
	bias?: ReactNode
	/**
	 * Heavy visualizers (span highlight, tree, timing, BIO, …), rendered from the result.
	 */
	extras?: (result: ParseResult) => ReactNode
	/**
	 * Rendered just above the result block (present or empty), for content that reads on THIS answer.
	 *
	 * A control that reads on the model rather than on an address belongs in {@link developerExtras}: above the result it
	 * is the first thing a visitor meets, and on a phone it pushes the answer below the fold.
	 */
	aboveResult?: (context: { result: ParseResult | null }) => ReactNode
	/**
	 * Host controls appended to the Developer sheet — the opt-in display toggles, whose state and the renderers they
	 * drive both belong to the host.
	 */
	developerExtras?: ReactNode
	/**
	 * Replace the package's default {@link ResultPanel} entirely. When provided, the host renders its own result block
	 * (span highlight, timing, hierarchy, precision detail, calibrated confidences) from the {@link ResultContext}. Absent
	 * → the built-in panel renders.
	 */
	result?: (context: ResultContext) => ReactNode
	/**
	 * Rendered in place of the resolved-place panel when nothing resolved (host's FailureDiagnostic). Ignored when
	 * {@link result} is set.
	 */
	failure?: (result: ParseResult) => ReactNode
	/**
	 * The version-compare view — the host renders its own diff from the compare state it owns.
	 */
	compare?: (context: CompareContext) => ReactNode
	/**
	 * The model-visualizer / debug drawer, mounted beside the map (host's ModelVisualizer). A render-prop so the host can
	 * trace the CURRENT result (its input) — the package passes the live parse result; the host decides on its own
	 * dev-mode state and returns `null` when the drawer is closed.
	 */
	debugDrawer?: (context: { result: ParseResult | null }) => ReactNode
	/**
	 * Extra map controls mounted as `<MapCanvas>` children (host's DebugControl / LayerToggle via `useControl`).
	 */
	mapControls?: ReactNode
	/**
	 * A layer control, rendered in the chrome's top column under the example chips rather than in a MapLibre corner.
	 *
	 * A render-prop taking the live map handle, because a layer control reads `getStyle().layers` and writes
	 * `setLayoutProperty` — it cannot be a static node. The handle is `null` until the map instantiates, so the host
	 * returns `null` for that first frame rather than rendering an empty control.
	 */
	layers?: (context: { map: MapInstance | null }) => ReactNode
	/**
	 * A permalink control for the current address (host's PermalinkButton).
	 */
	permalink?: (text: string) => ReactNode
}
