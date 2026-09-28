/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The map's rotation as React state, read through `useSyncExternalStore` and subscribed to `move` as well as `rotate`, since a `flyTo` or `easeTo` carrying a direction fires no rotate event.
 */

import { useCallback, useSyncExternalStore } from "react"
import type { MapInstance } from "react-map-gl/maplibre"

/**
 * The map's bearing and a callback that returns the map to north.
 */
export interface UseMapBearing {
	/**
	 * Degrees off north, as MapLibre reports it.
	 * Zero while there is no map.
	 */
	bearing: number
	/**
	 * Rotate the map back to north.
	 * A no-op while there is no map.
	 */
	resetNorth: () => void
}

/**
 * Reads the live map bearing and exposes `resetNorth`.
 */
export function useMapBearing(map: MapInstance | null): UseMapBearing {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!map) return () => undefined

			map.on("rotate", onChange)
			map.on("move", onChange)

			return () => {
				map.off("rotate", onChange)
				map.off("move", onChange)
			}
		},
		[map]
	)

	// The server snapshot is the same reading: the server renders no map.
	// and north is what a compass shows with no bearing to report.
	const readBearing = useCallback(() => map?.getBearing() ?? 0, [map])

	const bearing = useSyncExternalStore(subscribe, readBearing, () => 0)

	const resetNorth = useCallback(() => map?.easeTo({ bearing: 0, pitch: 0 }), [map])

	return { bearing, resetNorth }
}
