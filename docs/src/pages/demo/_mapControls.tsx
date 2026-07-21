/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<DemoMapControls>` — the `/demo` map controls injected into `<GeocoderDemo>` via
 *   `DemoPanels.mapControls` (rendered as `<DemoMap>` children, inside the react-map-gl `<Map>` context). It
 *   ports the live demo's two imperative `map.addControl(...)` calls onto the declarative binding:
 *
 *     - the top-right {@link LayerToggleControl} (per-group basemap-layer + coverage-fog visibility checkboxes),
 *       mounted via react-map-gl's `useControl`, and
 *     - the bottom-right feature-inspector {@link DebugControl}, fed the underlying maplibre map handle.
 *
 *   Reuses the exact docs components the live `/demo` uses, so the control chrome is identical.
 */

import type { Map as MapLibreMap } from "maplibre-gl"
import type React from "react"
import { useEffect, useState } from "react"
import { useControl, useMap } from "react-map-gl/maplibre"

import { LayerToggleControl } from "../../components/LayerToggleControl/LayerToggleControl.tsx"
import { DebugControl } from "./_debug.tsx"

/** Mounts the layer-toggle + feature-inspector controls on the surrounding `<Map>`. */
export const DemoMapControls: React.FC = () => {
	// The layer-toggle panel: a maplibre `IControl` mounted top-right (matches `_app.tsx`'s `addControl(..., "top-right")`).
	useControl(() => new LayerToggleControl(), { position: "top-right" })

	// The feature inspector needs the raw maplibre map handle. `useMap().current` is set once the map instance exists;
	// track it in state so `<DebugControl>` re-renders (and runs its `addControl` effect) when the map becomes ready.
	const { current: mapRef } = useMap()
	const [map, setMap] = useState<MapLibreMap | null>(null)

	useEffect(() => {
		setMap((mapRef?.getMap() as unknown as MapLibreMap) ?? null)
	}, [mapRef])

	return <DebugControl map={map} />
}
