/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapControls>` — the map controls injected into the geocoder via `GeocoderPanels.mapControls` (rendered as
 *   `<MapCanvas>` children, inside the react-map-gl `<Map>` context): the bottom-right feature-inspector
 *   {@link DebugControl}, fed the underlying maplibre map handle.
 *
 *   The layer control is NOT here. It reaches the chrome's top column through `GeocoderPanels.layers`, where the
 *   layout puts it under the example chips; a MapLibre corner control cannot sit in that column.
 */

import type React from "react"
import { useMap } from "react-map-gl/maplibre"

import { DebugControl } from "./MapDebug.tsx"

/**
 * Mounts the feature-inspector control on the surrounding `<Map>`.
 */
export const MapControls: React.FC = () => {
	// The feature inspector needs the raw maplibre map handle. `useMap().current` is set once the map instance exists;
	// track it in state so `<DebugControl>` re-renders (and runs its `addControl` effect) when the map becomes ready.
	const { current: mapRef } = useMap()
	const map = mapRef?.getMap() ?? null

	return <DebugControl map={map} />
}
