/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapControls>` — the map controls injected into the geocoder via `DemoPanels.mapControls` (rendered as
 *   `<DemoMap>` children, inside the react-map-gl `<Map>` context), on the declarative binding:
 *
 *     - the top-right {@link LayerToggleControl} (per-group basemap-layer + coverage-fog visibility checkboxes),
 *       mounted via react-map-gl's `useControl`, and
 *     - the bottom-right feature-inspector {@link DebugControl}, fed the underlying maplibre map handle.
 */

import type React from "react"
import { useControl, useMap } from "react-map-gl/maplibre"

import { LayerToggleControl } from "./LayerToggleControl/LayerToggleControl.tsx"
import { DebugControl } from "./MapDebug.tsx"

/**
 * Mounts the layer-toggle + feature-inspector controls on the surrounding `<Map>`.
 */
export const MapControls: React.FC = () => {
	// The layer-toggle panel: a maplibre `IControl` mounted top-right (matches `_app.tsx`'s `addControl(..., "top-right")`).
	useControl(() => new LayerToggleControl(), { position: "top-right" })

	// The feature inspector needs the raw maplibre map handle. `useMap().current` is set once the map instance exists;
	// track it in state so `<DebugControl>` re-renders (and runs its `addControl` effect) when the map becomes ready.
	const { current: mapRef } = useMap()
	const map = mapRef?.getMap() ?? null

	return <DebugControl map={map} />
}
