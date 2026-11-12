// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { centralAngle, ConversionFactor } from "@mailwoman/spatial/distance"
import type { FitBoundsOptions, FlyToOptions, JumpToOptions, LngLatBoundsLike } from "maplibre-gl"
import { type ReactNode, useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import type { MapCameraTarget } from "#map/place-render"
import { prefersReducedMotion } from "#map/reduced-motion"

/**
 * The arc, in degrees of the body's great circle, past which a result's camera move
 * jumps most of the way rather than animating across the globe.
 *
 * On Earth 13.5° is about 1,500 km, roughly New York to Chicago.
 * An angle rather than a distance keeps the rule the same on the Moon and Mars.
 *
 * An animated move between continents draws every frame at an intermediate zoom.
 * Each frame requests the basemap and elevation tiles under it, few of which the reader looks at.
 */
export const LONG_MOVE_DEGREES = 13.5

/**
 * The zoom a long move jumps to over its target before it animates in.
 *
 * At zoom 4 the view holds a few dozen tiles, so the jump costs little,
 * and the animation from there requests only tiles over the target.
 */
export const LONG_MOVE_OVERVIEW_ZOOM = 4

/**
 * Builds `fitBounds` options without an undefined `duration` key.
 *
 * MapLibre checks for existence and can turn into a NaN camera move.
 */
export function fitBoundsOptionsFor(padding: number, animate: boolean, maxZoom?: number): FitBoundsOptions {
	const options: FitBoundsOptions = animate ? { padding } : { padding, duration: 0 }

	if (typeof maxZoom === "number") {
		options.maxZoom = maxZoom
	}

	return options
}

/**
 * The point a camera target centers on.
 */
export function cameraTargetCenter(target: MapCameraTarget): [lon: number, lat: number] {
	if (target.kind === "center") return [target.center[0], target.center[1]]

	const [[west, south], [east, north]] = target.bounds

	return [(west + east) / 2, (south + north) / 2]
}

/**
 * The map methods a camera move calls, a subset of MapLibre's `Map`.
 */
export interface CameraMap {
	getCenter(): { lng: number; lat: number }
	getZoom(): number
	jumpTo(options: JumpToOptions): unknown
	flyTo(options: FlyToOptions): unknown
	fitBounds(bounds: LngLatBoundsLike, options?: FitBoundsOptions): unknown
}

/**
 * Moves `map` to `target`.
 *
 * A move animates unless `animate` is false or the reader prefers reduced motion.
 * An animated move longer than {@linkcode LONG_MOVE_DEGREES} first jumps to the target at
 * {@linkcode LONG_MOVE_OVERVIEW_ZOOM}, or at the current zoom when that's lower, then animates in.
 */
export function applyCameraTarget(map: CameraMap, target: MapCameraTarget, animate = true): void {
	const animated = animate && !prefersReducedMotion()

	if (animated) {
		const from = map.getCenter()
		const [lon, lat] = cameraTargetCenter(target)

		const arcDegrees = centralAngle(from.lat, from.lng, lat, lon) * ConversionFactor.RadiansToDegrees

		if (arcDegrees > LONG_MOVE_DEGREES) {
			map.jumpTo({ center: [lon, lat], zoom: Math.min(map.getZoom(), LONG_MOVE_OVERVIEW_ZOOM) })
		}
	}

	if (target.kind === "center") {
		if (animated) {
			map.flyTo({ center: target.center, zoom: target.zoom })
		} else {
			map.jumpTo({ center: target.center, zoom: target.zoom })
		}

		return
	}

	map.fitBounds(target.bounds, fitBoundsOptionsFor(target.padding, animated, target.maxZoom))
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

		applyCameraTarget(instance, target, animate)
	}, [map, target, animate])

	return null
}
