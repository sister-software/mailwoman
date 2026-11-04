// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `<CompactBuildings>` draws the compact building tiles that `?buildings3d=<tileset>` asks for with
 *   {@link CompactBuildingsLayer}, and the converted city models with {@link CityModelsLayer}. It hides the
 *   vector-tile building footprints while they draw, and the compact buildings inside each city model that has drawn.
 */

import { type CityTileset, cityTilesetPath } from "@mailwoman/structures/city-tilesets"
import cityTilesets from "@mailwoman/structures/data/city-tilesets.json" with { type: "json" }
import { useEffect } from "react"
import { useMap } from "react-map-gl/maplibre"

import { PRODUCTION_CONFIG } from "#config"
import { pageTilesetParam } from "#routes"

import { COMPACT_BUILDINGS_LAYER_ID, CompactBuildingsLayer } from "./compact-buildings/layer.ts"

/**
 * The city model layer's id, repeated here so removing it needs no import of the layer's module.
 */
const CITY_MODELS_LAYER_ID = "city-models"

const CITY_TILESETS = cityTilesets as CityTileset[]

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
		const hidden: string[] = []

		// three.js and 3DTilesRendererJS load only on a page that draws city models.
		// The main bundle stays without them.
		// The import starts once the building layer is on the map, so the city layer lands beside it.
		const mountCityModels = async () => {
			const { CityModelsLayer } = await import("#scene/city-models/layer")

			if (removed || map.getLayer(CITY_MODELS_LAYER_ID)) return

			const cityModels = new CityModelsLayer(
				CITY_TILESETS,
				(city) => new URL(cityTilesetPath(city), PRODUCTION_CONFIG.tileWorkerURL).href,
				(covered) => buildings.setHiddenAreas(covered.map((city) => city.bounds))
			)

			map.addLayer(cityModels, map.getStyle().layers.find((styleLayer) => styleLayer.type === "symbol")?.id)
		}

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

			for (const id of hidden.filter((layerID) => map.getLayer(layerID))) {
				map.setLayoutProperty(id, "visibility", "visible")
			}
		}
	}, [mapRef, tileset])

	return null
}
