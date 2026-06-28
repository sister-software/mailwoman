import type { Coordinates2D, GeoFeature, PointLiteral } from "@mailwoman/spatial"
import { useEffect, useState } from "react"

import { TILE_WORKER_URL } from "./_map-helpers.ts"

/**
 * Geographic center of contiguous US
 */
const DEFAULT_CENTER: Coordinates2D = [-95.7129, 37.0902]

export function useBrowserGeolocation(): Coordinates2D | null {
	const [coords, setCoords] = useState<Coordinates2D | null>(null)

	useEffect(() => {
		const fallback = () => setCoords(DEFAULT_CENTER)

		fetch(new URL("/geolocate", TILE_WORKER_URL), { signal: AbortSignal.timeout(5000) })
			.then((res) => {
				if (!res.ok) {
					fallback()

					return
				}

				return res.json()
			})
			.then((data: GeoFeature<PointLiteral>) => {
				const [lon, lat] = data.geometry.coordinates

				setCoords([lon, lat])
			})
			.catch(() => fallback())
	}, [])

	return coords
}
