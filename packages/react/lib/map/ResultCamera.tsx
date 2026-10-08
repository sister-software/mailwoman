/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { FitBoundsOptions } from "maplibre-gl"
import { type ReactNode, useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import type { MapCameraTarget } from "#map/place-render"

/**
 * Builds `fitBounds` options without an undefined `duration` key.
 *
 * MapLibre checks for existence and can turn into a NaN camera move.
 */
export function fitBoundsOptionsFor(padding: number, animate: boolean): FitBoundsOptions {
	return animate ? { padding } : { padding, duration: 0 }
}

/**
 * Props for {@link ResultCamera}.
 */
export interface ResultCameraProps {
	/**
	 * The camera target; `null` leaves the camera where it is.
	 */
	target: MapCameraTarget | null
	/**
	 * Whether to animate the move.
	 *
	 * @defaultValue `true`
	 */
	animate?: boolean
}

/**
 * Moves the map to `target`; mount it as a child of `<Map>`.
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
