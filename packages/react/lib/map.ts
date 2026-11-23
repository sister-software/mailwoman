// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/react/map` — the geocoder map surface, kept behind its own subpath
 *   so `maplibre-gl` / `react-map-gl` (WebGL + DOM at import) never enter the package-root graph.
 *
 *   The map subpath loads its map dependencies.
 *   The package root exposes parse and POI explorers without loading those dependencies.
 *
 *   Consumers who only want the parse/POI explorers never pay for maplibre.
 *
 *   The host must supply `maplibre-gl` + `react-map-gl` (peer deps) and import
 *   `maplibre-gl/dist/maplibre-gl.css` + `@mailwoman/react/styles.css` itself.
 */

export { MapCanvas } from "./map/canvas/MapCanvas.tsx"
export type { MapCanvasExtraProps, MapCanvasProps, MapCanvasStyle } from "./map/canvas/MapCanvas.tsx"

// ── Map chrome (node-safe presentation. The host supplies the input and reads its own map) ──
export { MapChipRow } from "./map/chrome/MapChipRow.tsx"
export type { MapChip, MapChipRowProps } from "./map/chrome/MapChipRow.tsx"
export { MapCompass } from "./map/chrome/MapCompass.tsx"
export type { MapCompassProps } from "./map/chrome/MapCompass.tsx"
export { useMapBearing } from "./map/camera/useMapBearing.ts"
export type { UseMapBearing } from "./map/camera/useMapBearing.ts"
export { useMapPick } from "./map/pick/useMapPick.ts"
export type { MapPick } from "./map/pick/useMapPick.ts"
export { MapPlaceCard, pickQuery } from "./map/pick/MapPlaceCard.tsx"
export type { MapPlaceCardProps } from "./map/pick/MapPlaceCard.tsx"

export {
	MapContextMenu,
	MapContextMenuAction,
	MapContextMenuRow,
	useMapContextMenu,
} from "./map/pick/MapContextMenu.tsx"

export type {
	MapContextMenuActionProps,
	MapContextMenuPoint,
	MapContextMenuProps,
	MapContextMenuRowProps,
	UseMapContextMenu,
} from "./map/pick/MapContextMenu.tsx"

export { MapControlButton, MapControlGroup, MapControlStack } from "./map/chrome/MapControlStack.tsx"

export type {
	MapControlButtonProps,
	MapControlGroupProps,
	MapControlStackProps,
} from "./map/chrome/MapControlStack.tsx"

export { MapFooter } from "./map/chrome/MapFooter.tsx"
export type { MapFooterProps } from "./map/chrome/MapFooter.tsx"
export { MapProgressBar } from "./map/chrome/MapProgressBar.tsx"
export type { MapProgressBarProps } from "./map/chrome/MapProgressBar.tsx"
export { MapSheet, SheetClose } from "./map/chrome/MapSheet.tsx"
export type { MapSheetProps } from "./map/chrome/MapSheet.tsx"
export { MapSearchBar, SearchGlyph } from "./map/chrome/MapSearchBar.tsx"
export type { MapSearchBarProps } from "./map/chrome/MapSearchBar.tsx"

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
export { approxCircleGeometry, bboxToBounds, geomBounds, radiusCircleGeometry } from "#map/overlays/geometry"
export type { BoundsTuple, PlaceGeometry } from "#map/overlays/geometry"
export { cameraToViewState, computeMapPlaceRenderSpec } from "#map/overlays/place-render"

export type {
	LngLat,
	MapCameraTarget,
	MapPlaceRenderSpec,
	PlaceTier,
	ResolvedMapPlace,
} from "#map/overlays/place-render"

export { useMapPlaceRender } from "#map/overlays/useMapPlaceRender"

// ── Declarative overlays (react-map-gl `<Marker>`/`<Source>`/`<Layer>`) ──────
export { OverlayLayers } from "./map/overlays/OverlayLayers.tsx"
export type { OverlayLayersProps } from "./map/overlays/OverlayLayers.tsx"
export { PlaceMarker } from "./map/overlays/PlaceMarker.tsx"
export type { PlaceMarkerProps } from "./map/overlays/PlaceMarker.tsx"
export { ResolvedPlaceLayers } from "./map/overlays/ResolvedPlaceLayers.tsx"
export type { ResolvedPlaceLayersProps } from "./map/overlays/ResolvedPlaceLayers.tsx"
export { ResultCamera } from "./map/camera/ResultCamera.tsx"
export type { ResultCameraProps } from "./map/camera/ResultCamera.tsx"
export { ResultOverlay } from "./map/overlays/ResultOverlay.tsx"
export type { ResultOverlayProps } from "./map/overlays/ResultOverlay.tsx"

// ── Geocoder controls + the composed geocoder ────────────────────────────────
export { CompareToggle } from "./map/geocoder/CompareToggle.tsx"
export type { CompareToggleProps } from "./map/geocoder/CompareToggle.tsx"
export { Geocoder } from "./map/geocoder/Geocoder.tsx"
export type { GeocoderProps } from "./map/geocoder/Geocoder.tsx"
export { GeocoderControls } from "./map/geocoder/GeocoderControls.tsx"
export type { GeocoderControlsProps } from "./map/geocoder/GeocoderControls.tsx"
export { PlaceAutocomplete } from "./map/geocoder/PlaceAutocomplete.tsx"
export type { PlaceAutocompleteProps } from "./map/geocoder/PlaceAutocomplete.tsx"
export { ResultPanel } from "./map/geocoder/ResultPanel.tsx"
export type { ResultPanelProps } from "./map/geocoder/ResultPanel.tsx"
export { useCompareState } from "#map/geocoder/useCompareState"
export type { UseCompareState } from "#map/geocoder/useCompareState"
export { useGeocode } from "#map/geocoder/useGeocode"
export type { UseGeocode, UseGeocodeOptions } from "#map/geocoder/useGeocode"
export { usePlaceAutocomplete } from "#map/geocoder/usePlaceAutocomplete"

export type {
	AutocompleteInputProps,
	UsePlaceAutocomplete,
	UsePlaceAutocompleteOptions,
} from "#map/geocoder/usePlaceAutocomplete"

export { VersionPicker } from "./map/geocoder/VersionPicker.tsx"
export type { VersionPickerProps } from "./map/geocoder/VersionPicker.tsx"
