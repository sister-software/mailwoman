/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Paints the procedural star sky onto a canvas that sits behind the map.
 *
 *   Under globe projection MapLibre leaves its canvas transparent outside the sphere, so a canvas stacked beneath it
 *   shows through around the globe. This component renders as a `<Map>` child so it can read the map instance.
 *   It redraws the sky canvas that `<MapCanvas>` owns on every camera move.
 */

import { useEffect, useMemo } from "react"
import type { ReactNode } from "react"
import { useMap } from "react-map-gl/maplibre"

import { drawStarfield, generateStarfield } from "#map/starfield"
import type { StarfieldOptions } from "#map/starfield"

export interface StarfieldLayerProps extends StarfieldOptions {
	/**
	 * The canvas behind the map that receives the sky.
	 */
	canvas: HTMLCanvasElement | null
}

/**
 * Keeps the sky canvas in step with the map camera.
 */
export function StarfieldLayer({
	canvas,
	count,
	seed,
	bandShare,
	background = "#02030a",
}: StarfieldLayerProps): ReactNode {
	const { current: mapRef } = useMap()
	const map = mapRef?.getMap()
	const catalog = useMemo(() => generateStarfield({ count, seed, bandShare }), [count, seed, bandShare])

	useEffect(() => {
		if (!map || !canvas) return

		const context = canvas.getContext("2d")

		if (!context) return

		let frame = 0

		const paint = () => {
			frame = 0

			const width = canvas.clientWidth
			const height = canvas.clientHeight
			const ratio = window.devicePixelRatio || 1
			const pixelWidth = Math.round(width * ratio)
			const pixelHeight = Math.round(height * ratio)

			if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
				canvas.width = pixelWidth
				canvas.height = pixelHeight
			}

			context.setTransform(ratio, 0, 0, ratio, 0, 0)

			// Mercator fills the canvas edge to edge, so the sky shows only around a globe.
			if (map.getProjection()?.type !== "globe") {
				context.clearRect(0, 0, width, height)

				return
			}

			const center = map.getCenter()

			drawStarfield(
				context,
				catalog,
				{
					lng: center.lng,
					lat: center.lat,
					bearing: map.getBearing(),
					pitch: map.getPitch(),
					fov: map.getVerticalFieldOfView(),
				},
				width,
				height,
				background
			)
		}

		const schedule = () => {
			if (!frame) {
				frame = requestAnimationFrame(paint)
			}
		}

		schedule()
		map.on("move", schedule)
		map.on("resize", schedule)
		map.on("styledata", schedule)

		return () => {
			if (frame) {
				cancelAnimationFrame(frame)
			}

			map.off("move", schedule)
			map.off("resize", schedule)
			map.off("styledata", schedule)
		}
	}, [map, canvas, catalog, background])

	return null
}
