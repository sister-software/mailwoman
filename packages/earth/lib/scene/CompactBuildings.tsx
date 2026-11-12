// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `<CompactBuildings>` draws the compact building tiles that `?buildings3d=<tileset>` asks for with
 *   {@link CompactBuildingsLayer}, and the converted city models with {@link CityModelsLayer}.
 *
 *   It hides the vector-tile building footprints while they draw, and the compact
 *   buildings inside each city model that's drawn.
 *
 *   Each layer mounts the first time the camera rests on a view it draws for,
 *   after the geocoder runtime has loaded.
 *   From then on it keeps what it loaded, and fetches more only while the camera rests.
 */

import { type CityTileset, cityTilesetPath } from "@mailwoman/structures/city-tilesets"
import cityTilesets from "@mailwoman/structures/data/city-tilesets.json" with { type: "json" }
import landmarks from "@mailwoman/structures/data/landmarks.json" with { type: "json" }
import { type Landmark, landmarkBounds } from "@mailwoman/structures/landmarks"
import type { Map as MapLibreMap } from "maplibre-gl"
import { useEffect, useRef } from "react"
import { useMap } from "react-map-gl/maplibre"

import { PRODUCTION_CONFIG } from "#config"
import { beginThreeDPhase, memoryProfile } from "#memory/profile"
import { pageTilesetParam } from "#routes"
import { DWELL_MIN_PITCH, DWELL_MS, type DwellCriteria, useCameraDwell } from "#scene/camera-dwell"
import type { CityModelsLayer } from "#scene/city-models/layer"

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

/**
 * The lowest zoom the city model layer draws at, repeated from its module for the same reason.
 */
const CITY_MODELS_MIN_ZOOM = 14

/**
 * The camera the compact buildings wait for.
 */
const COMPACT_BUILDINGS_DWELL: DwellCriteria = {
	minZoom: COMPACT_BUILDINGS_MIN_ZOOM,
	minPitch: DWELL_MIN_PITCH,
	dwellMs: DWELL_MS,
}

/**
 * The camera the city models wait for.
 */
const CITY_MODELS_DWELL: DwellCriteria = {
	minZoom: CITY_MODELS_MIN_ZOOM,
	minPitch: DWELL_MIN_PITCH,
	dwellMs: DWELL_MS,
}

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

function firstSymbolLayerID(map: MapLibreMap): string | undefined {
	return map.getStyle().layers.find((styleLayer) => styleLayer.type === "symbol")?.id
}

/**
 * Marks the 3D phase as running until the map next goes idle or the returned function runs.
 */
function guardUntilIdle(map: MapLibreMap): () => void {
	const end = beginThreeDPhase()

	map.once("idle", end)

	return () => {
		map.off("idle", end)
		end()
	}
}

/**
 * Mounts the GPU building and city model layers under the map's first label layer
 * when the page asks for a compact building tileset.
 */
export function CompactBuildings({ runtimeReady }: { runtimeReady: boolean }): null {
	const { current: mapRef } = useMap()
	const tileset = pageTilesetParam("buildings3d")
	const map = tileset && memoryProfile().threeD ? (mapRef?.getMap() ?? null) : null

	const buildingsDwell = useCameraDwell(map, COMPACT_BUILDINGS_DWELL, runtimeReady)
	const cityDwell = useCameraDwell(map, CITY_MODELS_DWELL, runtimeReady)
	const buildingsRef = useRef<CompactBuildingsLayer | null>(null)
	const cityModelsRef = useRef<CityModelsLayer | null>(null)
	const cityArmedRef = useRef(false)

	useEffect(() => {
		if (!map || !tileset || !buildingsDwell.everArmed) return

		const buildings = new CompactBuildingsLayer(
			(x, y) => new URL(`${tileset}/14/${x}/${y}.bin`, PRODUCTION_CONFIG.tileWorkerURL).href
		)

		// Each vector building layer the compact layer takes over from, with the zoom range the style gave it.
		const handedOff: Array<[id: string, range: [number, number]]> = []
		let endPhase: (() => void) | null = null

		const mount = () => {
			if (map.getLayer(COMPACT_BUILDINGS_LAYER_ID)) return

			// The extruded footprints would draw the same buildings twice where the compact
			// layer draws, so they stop at its lowest zoom and keep the zooms below it,
			// as the page without compact buildings shows them.
			// Address labels stay.
			for (const styleLayer of map.getStyle().layers) {
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
			endPhase = guardUntilIdle(map)
			map.addLayer(buildings, firstSymbolLayerID(map))
			buildingsRef.current = buildings
		}

		if (map.isStyleLoaded()) {
			mount()
		} else {
			map.once("load", mount)
		}

		return () => {
			map.off("load", mount)
			endPhase?.()
			buildingsRef.current = null

			if (map.getLayer(COMPACT_BUILDINGS_LAYER_ID)) {
				map.removeLayer(COMPACT_BUILDINGS_LAYER_ID)
			}

			for (const [id, [minzoom, maxzoom]] of handedOff.filter(([layerID]) => map.getLayer(layerID))) {
				map.setLayerZoomRange(id, minzoom, maxzoom)
			}
		}
	}, [map, tileset, buildingsDwell.everArmed])

	useEffect(() => {
		if (!map || !buildingsDwell.everArmed || !cityDwell.everArmed) return

		let removed = false
		let endPhase: (() => void) | null = null

		// three.js and 3DTilesRendererJS load only on a page that draws city models.
		// The main bundle stays without them.
		void (async () => {
			const { CityModelsLayer } = await import("#scene/city-models/layer")

			if (removed || map.getLayer(CITY_MODELS_LAYER_ID)) return

			const cityModels = new CityModelsLayer(
				CITY_TILESETS,
				(city) => new URL(cityTilesetPath(city), PRODUCTION_CONFIG.tileWorkerURL).href,
				(covered) => buildingsRef.current?.setHiddenAreas([...LANDMARK_AREAS, ...covered.map((city) => city.bounds)]),
				memoryProfile().budget
			)

			cityModels.setActivating(cityArmedRef.current)
			endPhase = guardUntilIdle(map)
			map.addLayer(cityModels, firstSymbolLayerID(map))
			cityModelsRef.current = cityModels
		})()

		return () => {
			removed = true
			endPhase?.()
			cityModelsRef.current = null

			if (map.getLayer(CITY_MODELS_LAYER_ID)) {
				map.removeLayer(CITY_MODELS_LAYER_ID)
			}
		}
	}, [map, buildingsDwell.everArmed, cityDwell.everArmed])

	// A layer already mounted keeps drawing what it loaded and fetches more only while the camera rests.
	useEffect(() => {
		buildingsRef.current?.setFetching(buildingsDwell.armed)
	}, [buildingsDwell.armed, buildingsDwell.everArmed])

	useEffect(() => {
		cityArmedRef.current = cityDwell.armed
		cityModelsRef.current?.setActivating(cityDwell.armed)
	}, [cityDwell.armed])

	return null
}
