/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<CompactBuildings>` draws the compact building tiles that `?buildings3d=<tileset>` asks for with
 *   {@link CompactBuildingsLayer}, and the converted city models with {@link CityModelsLayer}. It hides the
 *   vector-tile building footprints while they draw, and the compact buildings inside each city model that has drawn.
 */

import { type CityTileset, cityTilesetPath } from "@mailwoman/structures/city-tilesets"
import cityTilesets from "@mailwoman/structures/data/city-tilesets.json" with { type: "json" }
import landmarks from "@mailwoman/structures/data/landmarks.json" with { type: "json" }
import { type Landmark, landmarkBounds } from "@mailwoman/structures/landmarks"
import { useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import { PRODUCTION_CONFIG } from "#config"
import { pageTilesetParam } from "#routes"

import {
	COMPACT_BUILDINGS_LAYER_ID,
	COMPACT_BUILDINGS_MIN_ZOOM,
	CompactBuildingsLayer,
} from "./compact-buildings/layer.ts"

/**
 * The highest zoom a MapLibre style layer can declare.
 */
const MAX_STYLE_ZOOM = 24

/**
 * The city model layer's id, repeated here so removing it needs no import of the layer's module.
 */
const CITY_MODELS_LAYER_ID = "city-models"

const CITY_TILESETS = cityTilesets as CityTileset[]

/**
 * The square around each landmark inside which the building layer stops drawing,
 * because `<Scene3D>` draws the landmark's model there.
 *
 * Tiles built before a landmark joined the list still hold its footprint.
 *
 * The squares come first in the hidden-area list, so city models covering the
 * view cannot push them past the shader's limit.
 */
const LANDMARK_AREAS = (landmarks as Landmark[]).map(landmarkBounds)

/**
 * Mounts the GPU building and city model layers under the map's first label layer
 * when the page asks for a compact building tileset.
 */
export function CompactBuildings(): null {
	const { current: mapRef } = useMap()
	const tileset = pageTilesetParam("buildings3d")

	useEffect(() => {
		const map = mapRef?.getMap()

		if (!map || !tileset) return

		const buildings = new CompactBuildingsLayer(
			(x, y) => new URL(`${tileset}/14/${x}/${y}.bin`, PRODUCTION_CONFIG.tileWorkerURL).href
		)

		let removed = false
		// Each vector building layer the compact layer takes over from, with the zoom range the style gave it.
		const handedOff: Array<[id: string, range: [number, number]]> = []

		// three.js and 3DTilesRendererJS load only on a page that draws city models.
		// The main bundle stays without them.
		// The import starts once the building layer is on the map, so the city layer lands beside it.
		const mountCityModels = async () => {
			const { CityModelsLayer } = await import("#scene/city-models/layer")

			if (removed || map.getLayer(CITY_MODELS_LAYER_ID)) return

			const cityModels = new CityModelsLayer(
				CITY_TILESETS,
				(city) => new URL(cityTilesetPath(city), PRODUCTION_CONFIG.tileWorkerURL).href,
				(covered) => buildings.setHiddenAreas([...LANDMARK_AREAS, ...covered.map((city) => city.bounds)])
			)

			map.addLayer(cityModels, map.getStyle().layers.find((styleLayer) => styleLayer.type === "symbol")?.id)
		}

		const mount = () => {
			if (map.getLayer(COMPACT_BUILDINGS_LAYER_ID)) return

			const style = map.getStyle()

			// The extruded footprints would draw the same buildings twice where the compact
			// layer draws, so they stop at its lowest zoom and keep the zooms below it,
			// as the page without compact buildings shows them.
			// Address labels stay.
			for (const styleLayer of style.layers) {
				if (
					"source-layer" in styleLayer &&
					styleLayer["source-layer"] === "buildings" &&
					styleLayer.type !== "symbol"
				) {
					const range: [number, number] = [styleLayer.minzoom ?? 0, styleLayer.maxzoom ?? MAX_STYLE_ZOOM]
					map.setLayerZoomRange(styleLayer.id, range[0], Math.min(range[1], COMPACT_BUILDINGS_MIN_ZOOM))
					handedOff.push([styleLayer.id, range])
				}
			}

			buildings.setHiddenAreas(LANDMARK_AREAS)
			map.addLayer(buildings, style.layers.find((styleLayer) => styleLayer.type === "symbol")?.id)
			void mountCityModels()
		}

		if (map.isStyleLoaded()) {
			mount()
		} else {
			map.once("load", mount)
		}

		return () => {
			removed = true
			map.off("load", mount)

			for (const id of [CITY_MODELS_LAYER_ID, COMPACT_BUILDINGS_LAYER_ID].filter((layerID) => map.getLayer(layerID))) {
				map.removeLayer(id)
			}

			for (const [id, [minzoom, maxzoom]] of handedOff.filter(([layerID]) => map.getLayer(layerID))) {
				map.setLayerZoomRange(id, minzoom, maxzoom)
			}
		}
	}, [mapRef, tileset])

	return null
}
