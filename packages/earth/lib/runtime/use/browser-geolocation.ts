/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The map's initial centre: the tile worker's `/geolocate` answer for the visitor's connection, or the contiguous
 *   United States when that answer does not arrive. The map never waits on it; the hook answers null until one of the
 *   two is known, and the caller renders at the default in the meantime.
 */

import type { Coordinates2D, GeoFeature, PointLiteral } from "@mailwoman/spatial"
import { useEffect, useState } from "react"

import type { EarthConfig } from "#config"

/**
 * The geographic centre of the contiguous United States, as `[lon, lat]`.
 */
export const DEFAULT_CENTER: Coordinates2D = [-95.7129, 37.0902]

export function useBrowserGeolocation(config: EarthConfig): Coordinates2D | null {
	const [coords, setCoords] = useState<Coordinates2D | null>(null)

	useEffect(() => {
		const fallback = () => setCoords(DEFAULT_CENTER)

		fetch(new URL("/geolocate", config.tileWorkerURL), { signal: AbortSignal.timeout(5000) })
			.then((res) => {
				if (!res.ok) {
					fallback()

					return
				}

				return res.json() as Promise<GeoFeature<PointLiteral>>
			})
			.then((data) => {
				if (!data) return

				const [lon, lat] = data.geometry.coordinates

				setCoords([lon, lat])
			})
			.catch(() => fallback())
	}, [config.tileWorkerURL])

	return coords
}
