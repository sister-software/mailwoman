/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/react/map` — the geocoder-demo map surface, kept behind its OWN subpath so `maplibre-gl`
 *   / `react-map-gl` (WebGL + DOM at import) never enter the package-root graph. Importing this subpath
 *   pulls the map deps; importing `@mailwoman/react` (root) does not. Consumers who only want the
 *   parse/POI explorers never pay for maplibre.
 *
 *   The host must supply `maplibre-gl` + `react-map-gl` (peer deps) and import
 *   `maplibre-gl/dist/maplibre-gl.css` + `@mailwoman/react/styles.css` itself.
 */

export { DemoMap } from "./DemoMap.tsx"
export type { DemoMapExtraProps, DemoMapProps, DemoMapStyle } from "./DemoMap.tsx"
export type {
	DemoBackend,
	DemoRuntime,
	DemoVersionOption,
	LngLatTuple,
	MapBias,
	OverlaySpec,
	Suggestion,
} from "./types.ts"

// ── Pure geometry + render spec (node-safe; no react-map-gl at runtime) ──────
export { approxCircleGeometry, bboxToBounds, geomBounds, radiusCircleGeometry } from "./geometry.ts"
export type { BoundsTuple, PlaceBBox, PlaceGeometry } from "./geometry.ts"
export { cameraToViewState, computeMapPlaceRenderSpec } from "./place-render.ts"
export type { LngLat, MapCameraTarget, MapPlaceRenderSpec, PlaceTier, ResolvedMapPlace } from "./place-render.ts"
export { useMapPlaceRender } from "./useMapPlaceRender.ts"

// ── Declarative overlays (react-map-gl `<Marker>`/`<Source>`/`<Layer>`) ──────
export { OverlayLayers } from "./OverlayLayers.tsx"
export type { OverlayLayersProps } from "./OverlayLayers.tsx"
export { PlaceMarker } from "./PlaceMarker.tsx"
export type { PlaceMarkerProps } from "./PlaceMarker.tsx"
export { ResolvedPlaceLayers } from "./ResolvedPlaceLayers.tsx"
export type { ResolvedPlaceLayersProps } from "./ResolvedPlaceLayers.tsx"
export { ResultCamera } from "./ResultCamera.tsx"
export type { ResultCameraProps } from "./ResultCamera.tsx"
export { ResultOverlay } from "./ResultOverlay.tsx"
export type { ResultOverlayProps } from "./ResultOverlay.tsx"
