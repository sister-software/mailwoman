/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<Scene3D>` draws trees and modeled landmarks as meshes through a deck.gl overlay interleaved with the
 *   MapLibre layers, so the meshes share the map's depth buffer with the extruded buildings.
 */

import { COORDINATE_SYSTEM } from "@deck.gl/core"
import { Tile3DLayer } from "@deck.gl/geo-layers"
import { MapboxOverlay } from "@deck.gl/mapbox"
import { SimpleMeshLayer } from "@deck.gl/mesh-layers"
import { Tiles3DLoader } from "@loaders.gl/3d-tiles"
import { BUILDING_MODELED_STATE } from "@mailwoman/cartographer/base/buildings"
import { MailwomanBaseTileSetID } from "@mailwoman/cartographer/base/theme"
import { TreeLayers, TreePalette } from "@mailwoman/cartographer/base/trees"
import plateauTilesets from "@mailwoman/structures/data/plateau-tilesets.json" with { type: "json" }
import { electedPlateauTilesets, plateauTilesetsInView, type PlateauTileset } from "@mailwoman/structures/jp/plateau"
import { Matrix4, Vector3 } from "@math.gl/core"
import { Ellipsoid } from "@math.gl/geospatial"
import type { Map as MapInstance } from "maplibre-gl"
import type React from "react"
import { useEffect, useMemo } from "react"
import { useControl, useMap } from "react-map-gl/maplibre"

import { broadleafTreeMesh, coniferTreeMesh, tokyoSkytreeMesh, tokyoTowerMesh } from "./meshes.ts"

/**
 * A tree point from the `trees` source layer, in meters.
 */
interface TreeInstance {
	position: [number, number]
	height: number
	crownDiameter: number
	conifer: boolean
}

/**
 * Landmarks the basemap leaves out of its building layer so these meshes can draw them.
 *
 * The basemap's `Buildings.MODELED_LANDMARKS` lists the same coordinates.
 */
const Landmarks = [
	{ id: "tokyo-tower", position: [139.745433, 35.658581] as [number, number], mesh: tokyoTowerMesh },
	{ id: "tokyo-skytree", position: [139.8107, 35.710063] as [number, number], mesh: tokyoSkytreeMesh },
]

/**
 * The zoom below which the overlay clears its trees.
 *
 * The tiles carry tree points at z15.
 * Keeping the cached trees down to z14 lets them fade with distance when the camera zooms out across z15.
 */
const TREE_MIN_ZOOM = 14

/**
 * Exposes MapLibre 6's camera transform as `map.transform`.
 *
 * `@deck.gl/mapbox` 9.4 reads `map.transform` for the viewport size and clip planes.
 * MapLibre 6 keeps that object at `map._camera.transform`, so this property points the overlay there.
 */
function exposeTransform(map: MapInstance): void {
	if ("transform" in map) return

	Object.defineProperty(map, "transform", {
		configurable: true,
		get(this: { _camera: { transform: unknown } }) {
			return this._camera.transform
		},
	})
}

/**
 * The PLATEAU building tilesets whose CKAN record states the elected site policy.
 */
const CITY_MODELS = electedPlateauTilesets(
	plateauTilesets.map(({ bounds: [west = 0, south = 0, east = 0, north = 0], ...tileset }): PlateauTileset => ({
		...tileset,
		bounds: [west, south, east, north],
	}))
)

/**
 * The zoom from which the city models draw, where a building spans enough pixels for its roof to read.
 */
const CITY_MODEL_MIN_ZOOM = 15

/**
 * Tileset options that lower a tileset by its geoid height along the local vertical.
 *
 * A PLATEAU building placed above the WGS84 ellipsoid then stands on the map's 0 m ground.
 *
 * Tile3DLayer reads `loadOptions` once per tileset URL.
 * The cache keeps one object per tileset.
 *
 * Tileset3D's default 32 MB cache holds fewer PLATEAU tiles than one ward's view uses.
 * It then destroys tiles that are drawn or still loading.
 * A destroyed tile fails to parse with `assert failed: gltf`.
 */
const cityModelLoadOptions = new Map<string, { tileset: CityModelTilesetOptions }>()

interface CityModelTilesetOptions {
	modelMatrix: Matrix4
	maximumMemoryUsage: number
	maximumScreenSpaceError: number
}

const CITY_MODEL_MEMORY_MB = 512

/**
 * The screen-space error in pixels a tile may show before its children load.
 * Tileset3D defaults to 8.
 */
const CITY_MODEL_SCREEN_SPACE_ERROR = 16

function loadOptionsFor({ url, bounds: [west, south, east, north], geoidHeight }: PlateauTileset) {
	let options = cityModelLoadOptions.get(url)

	if (!options) {
		const up = Ellipsoid.WGS84.geodeticSurfaceNormalCartographic([(west + east) / 2, (south + north) / 2, 0])
		const offset = new Vector3(up).scale(-geoidHeight)

		options = {
			tileset: {
				modelMatrix: new Matrix4().translate(offset),
				maximumMemoryUsage: CITY_MODEL_MEMORY_MB,
				maximumScreenSpaceError: CITY_MODEL_SCREEN_SPACE_ERROR,
			},
		}

		cityModelLoadOptions.set(url, options)
	}

	return options
}

function cityModelsInView(map: MapInstance): PlateauTileset[] {
	if (map.getZoom() < CITY_MODEL_MIN_ZOOM) return []

	const bounds = map.getBounds()

	return plateauTilesetsInView(CITY_MODELS, [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()])
}

function containsPoint({ bounds: [west, south, east, north] }: PlateauTileset, [lng, lat]: number[]): boolean {
	return lng! >= west && lng! <= east && lat! >= south && lat! <= north
}

/**
 * Sets the modeled state on each loaded footprint whose first vertex lies inside a
 * drawn city model, and clears it from footprints that left one.
 *
 * The building layers then skip those footprints, so a city model and an
 * extrusion never draw the same building.
 *
 * `marked` holds the ids currently in the modeled state.
 */
function markModeledFootprints(map: MapInstance, cityModels: PlateauTileset[], marked: Set<string | number>): void {
	const target = { source: MailwomanBaseTileSetID, sourceLayer: "buildings" }
	const covered = new Set<string | number>()

	if (cityModels.length) {
		for (const feature of map.querySourceFeatures(MailwomanBaseTileSetID, { sourceLayer: "buildings" })) {
			const { id, geometry } = feature

			if (id == null || covered.has(id)) continue

			const ring =
				geometry.type === "Polygon"
					? geometry.coordinates[0]
					: geometry.type === "MultiPolygon"
						? geometry.coordinates[0]?.[0]
						: undefined

			const vertex = ring?.[0]

			if (vertex && cityModels.some((tileset) => containsPoint(tileset, vertex))) {
				covered.add(id)
			}
		}
	}

	for (const id of marked) {
		if (!covered.has(id)) {
			map.setFeatureState({ ...target, id }, { [BUILDING_MODELED_STATE]: false })
			marked.delete(id)
		}
	}

	for (const id of covered) {
		if (!marked.has(id)) {
			map.setFeatureState({ ...target, id }, { [BUILDING_MODELED_STATE]: true })
			marked.add(id)
		}
	}
}

/**
 * Adds the tree points of the tiles the map has loaded to `cache`, keyed by position
 * so the copies that adjacent tiles repeat collapse to one.
 *
 * Returns whether the cache gained a tree.
 */
function addLoadedTrees(map: MapInstance, cache: Map<string, TreeInstance>): boolean {
	let added = false

	for (const feature of map.querySourceFeatures(MailwomanBaseTileSetID, {
		sourceLayer: "trees",
		filter: ["==", ["get", "kind"], "tree"],
	})) {
		if (feature.geometry.type !== "Point") continue
		const [lon, lat] = feature.geometry.coordinates as [number, number]
		const key = `${lon.toFixed(6)},${lat.toFixed(6)}`
		const height = Number(feature.properties["height"])
		const crownDiameter = Number(feature.properties["crown_diameter"])

		if (cache.has(key) || !(height > 0 && crownDiameter > 0)) continue

		cache.set(key, {
			position: [lon, lat],
			height,
			crownDiameter,
			conifer: feature.properties["leaf_type"] === "needleleaved",
		})

		added = true
	}

	return added
}

/**
 * Removes the trees outside twice the visible bounds, keeping a margin so a short pan reuses them.
 *
 * Returns whether the cache lost a tree.
 */
function pruneDistantTrees(map: MapInstance, cache: Map<string, TreeInstance>): boolean {
	const bounds = map.getBounds()
	const lonMargin = (bounds.getEast() - bounds.getWest()) / 2
	const latMargin = (bounds.getNorth() - bounds.getSouth()) / 2
	let removed = false

	for (const [key, { position }] of cache) {
		const [lon, lat] = position

		if (
			lon < bounds.getWest() - lonMargin ||
			lon > bounds.getEast() + lonMargin ||
			lat < bounds.getSouth() - latMargin ||
			lat > bounds.getNorth() + latMargin
		) {
			cache.delete(key)
			removed = true
		}
	}

	return removed
}

/**
 * Mounts the deck.gl overlay on the surrounding `<Map>`.
 *
 * The overlay draws a tree mesh at each `kind=tree` point in the loaded tiles
 * and hides the extruded tree layers.
 */
export const Scene3D: React.FC = () => {
	const { current: mapRef } = useMap()
	const map = mapRef?.getMap() ?? null

	if (map) {
		exposeTransform(map)
	}

	const overlay = useControl(() => new MapboxOverlay({ interleaved: true, layers: [] }))

	const meshes = useMemo(
		() => ({
			broadleaf: broadleafTreeMesh(TreePalette.trunk, TreePalette.crown),
			conifer: coniferTreeMesh(TreePalette.trunk, TreePalette.needleCrown),
			landmarks: Landmarks.map((landmark) => ({ ...landmark, mesh: landmark.mesh() })),
		}),
		[]
	)

	useEffect(() => {
		if (!map) return

		// Trees accumulate as tiles load and leave only when they fall far outside the view,
		// so a pan or a tile reload keeps the trees already drawn.
		// The overlay redraws only when the cache changes.
		const trees = new Map<string, TreeInstance>()
		const modeledFootprints = new Set<string | number>()
		let drawnSize = -1
		let drawnCityModels: string | null = null
		let changed = true

		// Every read of the style runs once the style has loaded and `getStyle()` lists its layers.
		const update = () => {
			if (!map.isStyleLoaded()) return

			if (map.getZoom() < TREE_MIN_ZOOM) {
				changed ||= trees.size > 0
				trees.clear()
			} else {
				changed = addLoadedTrees(map, trees) || changed
				changed = pruneDistantTrees(map, trees) || changed
			}

			const cityModels = cityModelsInView(map)
			const cityModelKey = cityModels.map((tileset) => tileset.url).join(" ")

			markModeledFootprints(map, cityModels, modeledFootprints)

			if (!changed && drawnSize === trees.size && drawnCityModels === cityModelKey) return
			changed = false
			drawnSize = trees.size
			drawnCityModels = cityModelKey

			// The overlay draws every tree, so the extruded tree layers stay hidden while it is mounted.
			for (const layer of TreeLayers) {
				if (map.getLayer(layer.id) && map.getLayoutProperty(layer.id, "visibility") !== "none") {
					map.setLayoutProperty(layer.id, "visibility", "none")
				}
			}

			// Interleaved deck.gl layers join the end of MapLibre's layer list unless they name a `beforeId`.
			// Inserting them before the first symbol layer keeps every label drawn above the meshes.
			// `@deck.gl/mapbox` reads the prop from every layer and declares it in an
			// internal type, so each layer spreads it in from this object.
			const placement = { beforeId: map.getStyle().layers.find((layer) => layer.type === "symbol")?.id }

			const cached = [...trees.values()]

			const treeLayer = (id: string, data: TreeInstance[], mesh: typeof meshes.broadleaf) =>
				new SimpleMeshLayer<TreeInstance>({
					id,
					...placement,
					data,
					mesh,
					getPosition: (d) => d.position,
					getScale: (d) => [d.crownDiameter, d.crownDiameter, d.height],
					// A small per-tree variation in shade keeps a row of identical meshes from reading as one block.
					getColor: (d) => {
						const shade = 230 + ((d.position[0] * 1e6 + d.position[1] * 1e6) % 25)

						return [shade, shade, shade]
					},
					material: { ambient: 0.6, diffuse: 0.55, shininess: 8, specularColor: [20, 20, 20] },
				})

			const landmarkLayers = meshes.landmarks.map(
				(landmark) =>
					new SimpleMeshLayer({
						id: `landmark-${landmark.id}`,
						...placement,
						data: [landmark],
						mesh: landmark.mesh,
						getPosition: (d: typeof landmark) => d.position,
						getColor: [255, 255, 255],
						coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
						material: { ambient: 0.55, diffuse: 0.6, shininess: 24, specularColor: [40, 40, 40] },
					})
			)

			overlay.setProps({
				layers: [
					treeLayer(
						"trees-broadleaf",
						cached.filter((tree) => !tree.conifer),
						meshes.broadleaf
					),
					treeLayer(
						"trees-conifer",
						cached.filter((tree) => tree.conifer),
						meshes.conifer
					),
					...landmarkLayers,
					...cityModels.map(
						(tileset) =>
							new Tile3DLayer({
								id: `city-model-${tileset.cityCode}-${tileset.year}`,
								...placement,
								data: tileset.url,
								loader: Tiles3DLoader,
								loadOptions: loadOptionsFor(tileset),
							})
					),
				],
			})
		}

		// A tile load fires `sourcedata` many times per frame, so updates run at most once per animation frame.
		let frame = 0

		const schedule = () => {
			if (!frame) {
				frame = requestAnimationFrame(() => {
					frame = 0
					update()
				})
			}
		}

		schedule()
		map.on("sourcedata", schedule)
		map.on("moveend", schedule)

		return () => {
			cancelAnimationFrame(frame)
			map.off("sourcedata", schedule)
			map.off("moveend", schedule)
		}
	}, [map, overlay, meshes])

	return null
}
