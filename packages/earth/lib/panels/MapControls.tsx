/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapControls>` — the map controls injected into the geocoder via `GeocoderPanels.mapControls` (rendered as
 *   `<MapCanvas>` children, inside the react-map-gl `<Map>` context): the {@link JurisdictionInspector}'s
 *   legend and hover card, and in developer mode the bottom-right feature-inspector {@link DebugControl}. Both
 *   are fed the underlying maplibre map handle.
 *
 *   The layer control is not here. It reaches the chrome's top column through `GeocoderPanels.layers`, where the
 *   layout puts it under the example chips. a MapLibre corner control cannot sit in that column.
 */

import type React from "react"
import { useMap } from "react-map-gl/maplibre"

import { JurisdictionInspector } from "./JurisdictionInspector.tsx"
import { DebugControl } from "./MapDebug.tsx"

/**
 * Mounts the jurisdiction legend and hover card on the surrounding `<Map>`,
 * and the feature-inspector control in developer mode.
 */
export const MapControls: React.FC<{ devMode: boolean }> = ({ devMode }) => {
	// The controls need the raw maplibre map handle.
	// `useMap().current` is set once the map instance exists.
	// Track it in state so the controls re-render (and run their effects) when the map becomes ready.
	const { current: mapRef } = useMap()
	const map = mapRef?.getMap() ?? null

	return (
		<>
			<JurisdictionInspector map={map} />
			{devMode ? <DebugControl map={map} /> : null}
		</>
	)
}
