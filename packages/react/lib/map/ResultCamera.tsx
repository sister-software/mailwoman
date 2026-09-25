/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Apply a resolved place's camera target through MapLibre's imperative `flyTo` or `fitBounds` APIs.
 *   Renders no DOM; controlled-map consumers can instead use `cameraToViewState` for center targets.
 */

import type { FitBoundsOptions } from "maplibre-gl"
import { type ReactNode, useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import type { MapCameraTarget } from "#map/place-render"

/**
 * Build bounds options without an undefined `duration` key.
 * MapLibre branches on key presence, so `duration: undefined` can produce a NaN camera flight.
 */
export function fitBoundsOptionsFor(padding: number, animate: boolean): FitBoundsOptions {
	return animate ? { padding } : { padding, duration: 0 }
}

export interface ResultCameraProps {
	/**
	 * The camera target to animate to.
	 *
	 * `null` leaves the camera untouched (no result yet).
	 */
	target: MapCameraTarget | null
	/**
	 * Animate (`flyTo`/`fitBounds`) vs jump. @default true.
	 *
	 * When false, a `center` target jumps with `jumpTo`; a `bounds` target still uses
	 * `fitBounds` (no instantaneous fit exists) but with `duration: 0`.
	 */
	animate?: boolean
}

/**
 * Drive the live map to `target`.
 *
 * No DOM of its own — it is a behavior mounted as a `<Map>` child.
 */
export function ResultCamera({ target, animate = true }: ResultCameraProps): ReactNode {
	const map = useMap()

	useEffect(() => {
		const instance = map.current?.getMap()

		if (!instance || !target) return

		if (target.kind === "center") {
			if (animate) {
				instance.flyTo({ center: target.center, zoom: target.zoom })
			} else {
				instance.jumpTo({ center: target.center, zoom: target.zoom })
			}

			return
		}

		instance.fitBounds(target.bounds, fitBoundsOptionsFor(target.padding, animate))
	}, [map, target, animate])

	return null
}
