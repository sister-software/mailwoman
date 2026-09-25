/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Re-exports the shared presentational components and hooks that both explorers are built from.
 *
 * No module in the root graph imports CSS, so the bare package import is Node-safe
 * and hosts load `@mailwoman/react/styles.css` themselves.
 */
export * from "#common/index"
/**
 * Re-exports `POIExplorer`, a POI-intent tester that needs no weights or network, and its parts.
 */
export * from "#poi/index"
/**
 * Re-exports `PipelineExplorer`, a parse-and-resolve tester whose model
 * and gazetteer access the host injects, and its parts.
 */
export * from "#pipeline/index"
/**
 * Re-exports `useReleaseRuntime`, the Node-safe hook that loads a release manifest
 * and each selected version's assets through a host-injected loader.
 */
export * from "#runtime/index"

/**
 * Re-exports the map surface's types only, because its runtime lives behind the
 * `@mailwoman/react/map` subpath so that MapLibre stays out of the root import graph.
 */
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
