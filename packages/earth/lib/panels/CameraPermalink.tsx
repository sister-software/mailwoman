/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<CameraPermalink>` keeps the address bar on the map's camera, as `/@<lat>,<lon>,<zoom>z`.
 */

import type React from "react"
import { useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import { pathWithCamera } from "#routes"

/**
 * Writes the camera into the URL after every move, so a copied address reopens the same view.
 *
 * The write uses `replaceState`, which updates the current history entry,
 * so the back button leaves the map in one step.
 */
export const CameraPermalink: React.FC = () => {
	const { current: mapRef } = useMap()
	const map = mapRef?.getMap() ?? null

	useEffect(() => {
		if (!map) return

		const write = () => {
			const { lng, lat } = map.getCenter()

			history.replaceState(history.state, "", pathWithCamera(new URL(location.href), [lng, lat], map.getZoom()))
		}

		map.on("moveend", write)

		return () => {
			map.off("moveend", write)
		}
	}, [map])

	return null
}
