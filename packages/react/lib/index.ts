/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/react` — React components + headless hooks for mailwoman.
 *
 *   Two composed explorers plus the small presentational units and headless hooks they decompose into:
 *
 *   - `POIExplorer` — a self-contained POI-intent tester (classify → subject → OverpassQL), with an
 *     optional injected live poi.db search. No weights, no network on the intent path.
 *   - `PipelineExplorer` — a parse+resolve tester driven by an INJECTED `PipelineRuntime`, so the
 *     model/gazetteer plumbing (ONNX, httpvfs, node builtins) stays in the host, never in this graph.
 *
 *   Styling ships separately as `@mailwoman/react/styles.css` (plain, `mw-`-prefixed, Infima-token
 *   aware) — no CSS is imported by the component modules, so the bare package import is node-safe.
 */

export * from "#common/index"
export * from "#poi/index"
export * from "#pipeline/index"
export * from "#runtime/index"

export type {
	GeocoderRuntime,
	InferenceBackend,
	LngLatTuple,
	MapBias,
	MapCanvasExtraProps,
	MapCanvasProps,
	MapCanvasStyle,
	OverlaySpec,
	Suggestion,
	VersionOption,
} from "#map/index"
