/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/react/map` — the geocoder map surface, kept behind its OWN subpath so `maplibre-gl`
 *   / `react-map-gl` (WebGL + DOM at import) never enter the package-root graph. Importing this subpath
 *   pulls the map deps; importing `@mailwoman/react` (root) does not. Consumers who only want the
 *   parse/POI explorers never pay for maplibre.
 *
 *   The host must supply `maplibre-gl` + `react-map-gl` (peer deps) and import
 *   `maplibre-gl/dist/maplibre-gl.css` + `@mailwoman/react/styles.css` itself.
 */

export { MapCanvas } from "./MapCanvas.tsx"
export type { MapCanvasExtraProps, MapCanvasProps, MapCanvasStyle } from "./MapCanvas.tsx"

// ── Map chrome (node-safe presentation; the host supplies the input and reads its own map) ──
export { MapChipRow } from "./MapChipRow.tsx"
export type { MapChip, MapChipRowProps } from "./MapChipRow.tsx"
export { MapCompass } from "./MapCompass.tsx"
export type { MapCompassProps } from "./MapCompass.tsx"
export { useMapBearing } from "./useMapBearing.ts"
export type { UseMapBearing } from "./useMapBearing.ts"
export { useMapLabelPick } from "./useMapLabelPick.ts"
export { MapControlButton, MapControlGroup, MapControlStack } from "./MapControlStack.tsx"
export type { MapControlButtonProps, MapControlGroupProps, MapControlStackProps } from "./MapControlStack.tsx"
export { MapFooter } from "./MapFooter.tsx"
export type { MapFooterProps } from "./MapFooter.tsx"
export { MapProgressBar } from "./MapProgressBar.tsx"
export type { MapProgressBarProps } from "./MapProgressBar.tsx"
export { MapSheet } from "./MapSheet.tsx"
export type { MapSheetProps } from "./MapSheet.tsx"
export { MapSearchBar } from "./MapSearchBar.tsx"
export type { MapSearchBarProps } from "./MapSearchBar.tsx"

export type {
	CompareContext,
	GeocoderPanels,
	GeocoderRuntime,
	InferenceBackend,
	LngLatTuple,
	MapBias,
	OverlaySpec,
	ResultContext,
	Suggestion,
	VersionOption,
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

// ── Geocoder controls + the composed geocoder ────────────────────────────────
export { BackendControl } from "./BackendControl.tsx"
export type { BackendControlProps } from "./BackendControl.tsx"
export { CompareToggle } from "./CompareToggle.tsx"
export type { CompareToggleProps } from "./CompareToggle.tsx"
export { Geocoder } from "./Geocoder.tsx"
export type { GeocoderProps } from "./Geocoder.tsx"
export { GeocoderControls } from "./GeocoderControls.tsx"
export type { GeocoderControlsProps } from "./GeocoderControls.tsx"
export { PlaceAutocomplete } from "./PlaceAutocomplete.tsx"
export type { PlaceAutocompleteProps } from "./PlaceAutocomplete.tsx"
export { ResultPanel } from "./ResultPanel.tsx"
export type { ResultPanelProps } from "./ResultPanel.tsx"
export { useCompareState } from "#map/useCompareState"
export type { UseCompareState } from "#map/useCompareState"
export { useGeocode } from "#map/useGeocode"
export type { UseGeocode, UseGeocodeOptions } from "#map/useGeocode"
export { usePlaceAutocomplete } from "#map/usePlaceAutocomplete"

export type {
	AutocompleteInputProps,
	UsePlaceAutocomplete,
	UsePlaceAutocompleteOptions,
} from "#map/usePlaceAutocomplete"

export { VersionPicker } from "./VersionPicker.tsx"
export type { VersionPickerProps } from "./VersionPicker.tsx"
