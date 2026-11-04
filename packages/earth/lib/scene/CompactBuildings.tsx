/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<CompactBuildings>` draws the compact building tiles that `?buildings3d=<tileset>` asks for with
 *   {@link CompactBuildingsLayer}, and hides the vector-tile building footprints while it does.
 */

import { useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import { PRODUCTION_CONFIG } from "#config"
import { pageTilesetParam } from "#routes"

import { COMPACT_BUILDINGS_LAYER_ID, CompactBuildingsLayer } from "./compact-buildings/layer.ts"

/**
 * Mounts the GPU building layer under the map's first label layer when the page
 * asks for a compact building tileset.
 */
export function CompactBuildings(): null {
	const { current: mapRef } = useMap()
	const tileset = pageTilesetParam("buildings3d")

	useEffect(() => {
		const map = mapRef?.getMap()

		if (!map || !tileset) return

		const layer = new CompactBuildingsLayer(
			(x, y) => new URL(`${tileset}/14/${x}/${y}.bin`, PRODUCTION_CONFIG.tileWorkerURL).href
		)

		const hidden: string[] = []

		const mount = () => {
			if (map.getLayer(COMPACT_BUILDINGS_LAYER_ID)) return

			const style = map.getStyle()

			// The extruded footprints would draw the same buildings twice.
			// Address labels stay.
			for (const styleLayer of style.layers) {
				if (
					"source-layer" in styleLayer &&
					styleLayer["source-layer"] === "buildings" &&
					styleLayer.type !== "symbol"
				) {
					map.setLayoutProperty(styleLayer.id, "visibility", "none")
					hidden.push(styleLayer.id)
				}
			}

			map.addLayer(layer, style.layers.find((styleLayer) => styleLayer.type === "symbol")?.id)
		}

		if (map.isStyleLoaded()) {
			mount()
		} else {
			map.once("load", mount)
		}

		return () => {
			map.off("load", mount)

			if (map.getLayer(COMPACT_BUILDINGS_LAYER_ID)) {
				map.removeLayer(COMPACT_BUILDINGS_LAYER_ID)
			}

			for (const id of hidden.filter((layerID) => map.getLayer(layerID))) {
				map.setLayoutProperty(id, "visibility", "visible")
			}
		}
	}, [mapRef, tileset])

	return null
}
