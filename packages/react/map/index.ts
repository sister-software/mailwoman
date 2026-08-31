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
	DemoCompareContext,
	DemoPanels,
	DemoResultContext,
	DemoRuntime,
	DemoVersionOption,
	LngLatTuple,
	MapBias,
	OverlaySpec,
	Suggestion,
} from "#map/types"

// ── Pure geometry + render spec (node-safe; no react-map-gl at runtime) ──────
export { approxCircleGeometry, bboxToBounds, geomBounds, radiusCircleGeometry } from "#map/geometry"
export type { BoundsTuple, PlaceBBox, PlaceGeometry } from "#map/geometry"
export { cameraToViewState, computeMapPlaceRenderSpec } from "#map/place-render"
export type { LngLat, MapCameraTarget, MapPlaceRenderSpec, PlaceTier, ResolvedMapPlace } from "#map/place-render"
export { useMapPlaceRender } from "#map/useMapPlaceRender"

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

// ── Demo controls + composed demo (phase 4) ─────────────────────────────────
export { BackendControl } from "./BackendControl.tsx"
export type { BackendControlProps } from "./BackendControl.tsx"
export { CompareToggle } from "./CompareToggle.tsx"
export type { CompareToggleProps } from "./CompareToggle.tsx"
export { DemoControls } from "./DemoControls.tsx"
export type { DemoControlsProps } from "./DemoControls.tsx"
export { GeocoderDemo } from "./GeocoderDemo.tsx"
export type { GeocoderDemoProps } from "./GeocoderDemo.tsx"
export { PlaceAutocomplete } from "./PlaceAutocomplete.tsx"
export type { PlaceAutocompleteProps } from "./PlaceAutocomplete.tsx"
export { ResultPanel } from "./ResultPanel.tsx"
export type { ResultPanelProps } from "./ResultPanel.tsx"
export { useCompareState } from "#map/useCompareState"
export type { UseCompareState } from "#map/useCompareState"
export { useDemoGeocode } from "#map/useDemoGeocode"
export type { UseDemoGeocode, UseDemoGeocodeOptions } from "#map/useDemoGeocode"
export { usePlaceAutocomplete } from "#map/usePlaceAutocomplete"

export type {
	AutocompleteInputProps,
	UsePlaceAutocomplete,
	UsePlaceAutocompleteOptions,
} from "#map/usePlaceAutocomplete"

export { VersionPicker } from "./VersionPicker.tsx"
export type { VersionPickerProps } from "./VersionPicker.tsx"
