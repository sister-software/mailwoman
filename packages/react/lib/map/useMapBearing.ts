/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useMapBearing` — the map's rotation as React state, for a compass that appears off north and fades back.
 *
 *   The map is an external store, so it is read through `useSyncExternalStore` rather than mirrored into state by an
 *   effect: the bearing is a number, which makes a stable snapshot, and React tears nothing during a concurrent
 *   render.
 *
 *   It listens on `rotate` rather than `rotateend`, because the needle has to track the gesture rather than snap once
 *   the gesture is over. `move` is subscribed too: a `flyTo` or an `easeTo` carrying a bearing rotates the map without
 *   firing a rotate event, and a compass that misses those stays pointing north over a turned map.
 */

import { useCallback, useSyncExternalStore } from "react"
import type { MapInstance } from "react-map-gl/maplibre"

export interface UseMapBearing {
	/**
	 * Degrees off north, as MapLibre reports it. Zero while there is no map.
	 */
	bearing: number
	/**
	 * Rotate the map back to north. A no-op while there is no map.
	 */
	resetNorth: () => void
}

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

	// The server snapshot is the same reading: there is no map during a server render, and north is what a compass
	// shows when it has nothing to report.
	const readBearing = useCallback(() => map?.getBearing() ?? 0, [map])

	const bearing = useSyncExternalStore(subscribe, readBearing, () => 0)

	const resetNorth = useCallback(() => map?.easeTo({ bearing: 0, pitch: 0 }), [map])

	return { bearing, resetNorth }
}
