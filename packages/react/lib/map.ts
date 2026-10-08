/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/react/map` — the geocoder map surface, kept behind its own subpath so `maplibre-gl`
 *   / `react-map-gl` (WebGL + DOM at import) never enter the package-root graph. This subpath import
 *   pulls the map deps. importing `@mailwoman/react` (root) does not. Consumers who only want the
 *   parse/POI explorers never pay for maplibre.
 *
 *   The host must supply `maplibre-gl` + `react-map-gl` (peer deps) and import
 *   `maplibre-gl/dist/maplibre-gl.css` + `@mailwoman/react/styles.css` itself.
 */

export { MapCanvas } from "./map/MapCanvas.tsx"
export type { MapCanvasExtraProps, MapCanvasProps, MapCanvasStyle } from "./map/MapCanvas.tsx"

// ── Map chrome (node-safe presentation. The host supplies the input and reads its own map) ──
export { MapChipRow } from "./map/MapChipRow.tsx"
export type { MapChip, MapChipRowProps } from "./map/MapChipRow.tsx"
export { MapCompass } from "./map/MapCompass.tsx"
export type { MapCompassProps } from "./map/MapCompass.tsx"
export { useMapBearing } from "./map/useMapBearing.ts"
export type { UseMapBearing } from "./map/useMapBearing.ts"
export { useMapLabelPick } from "./map/useMapLabelPick.ts"
export { MapControlButton, MapControlGroup, MapControlStack } from "./map/MapControlStack.tsx"
export type { MapControlButtonProps, MapControlGroupProps, MapControlStackProps } from "./map/MapControlStack.tsx"
export { MapFooter } from "./map/MapFooter.tsx"
export type { MapFooterProps } from "./map/MapFooter.tsx"
export { MapProgressBar } from "./map/MapProgressBar.tsx"
export type { MapProgressBarProps } from "./map/MapProgressBar.tsx"
export { MapSheet, SheetClose } from "./map/MapSheet.tsx"
export type { MapSheetProps } from "./map/MapSheet.tsx"
export { MapSearchBar, SearchGlyph } from "./map/MapSearchBar.tsx"
export type { MapSearchBarProps } from "./map/MapSearchBar.tsx"

export type {
	CompareContext,
	GeocoderPanels,
	GeocoderRuntime,
	LngLatTuple,
	MapBias,
	OverlaySpec,
	ResultContext,
	Suggestion,
	VersionOption,
} from "#map/types"

// ── Pure geometry + render spec (node-safe. No react-map-gl at runtime) ──────
export { approxCircleGeometry, bboxToBounds, geomBounds, radiusCircleGeometry } from "#map/geometry"
export type { BoundsTuple, PlaceGeometry } from "#map/geometry"
export { cameraToViewState, computeMapPlaceRenderSpec } from "#map/place-render"
export type { LngLat, MapCameraTarget, MapPlaceRenderSpec, PlaceTier, ResolvedMapPlace } from "#map/place-render"
export { useMapPlaceRender } from "#map/useMapPlaceRender"

// ── Declarative overlays (react-map-gl `<Marker>`/`<Source>`/`<Layer>`) ──────
export { OverlayLayers } from "./map/OverlayLayers.tsx"
export type { OverlayLayersProps } from "./map/OverlayLayers.tsx"
export { PlaceMarker } from "./map/PlaceMarker.tsx"
export type { PlaceMarkerProps } from "./map/PlaceMarker.tsx"
export { ResolvedPlaceLayers } from "./map/ResolvedPlaceLayers.tsx"
export type { ResolvedPlaceLayersProps } from "./map/ResolvedPlaceLayers.tsx"
export { ResultCamera } from "./map/ResultCamera.tsx"
export type { ResultCameraProps } from "./map/ResultCamera.tsx"
export { ResultOverlay } from "./map/ResultOverlay.tsx"
export type { ResultOverlayProps } from "./map/ResultOverlay.tsx"

// ── Geocoder controls + the composed geocoder ────────────────────────────────
export { CompareToggle } from "./map/CompareToggle.tsx"
export type { CompareToggleProps } from "./map/CompareToggle.tsx"
export { Geocoder } from "./map/Geocoder.tsx"
export type { GeocoderProps } from "./map/Geocoder.tsx"
export { GeocoderControls } from "./map/GeocoderControls.tsx"
export type { GeocoderControlsProps } from "./map/GeocoderControls.tsx"
export { PlaceAutocomplete } from "./map/PlaceAutocomplete.tsx"
export type { PlaceAutocompleteProps } from "./map/PlaceAutocomplete.tsx"
export { ResultPanel } from "./map/ResultPanel.tsx"
export type { ResultPanelProps } from "./map/ResultPanel.tsx"
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

export { VersionPicker } from "./map/VersionPicker.tsx"
export type { VersionPickerProps } from "./map/VersionPicker.tsx"
