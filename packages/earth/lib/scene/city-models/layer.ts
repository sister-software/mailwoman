// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A MapLibre custom layer that draws converted city models, 3D Tiles 1.1 served by the tile worker,
 *   with 3DTilesRendererJS and three.js on the map's own WebGL context and depth buffer.
 *
 *   The tiles are in Earth-centered coordinates (ECEF).
 *   For each tileset the layer builds the matrix from ECEF to MapLibre's mercator world:
 *   a local east-north-up frame at the tileset's center, scaled to mercator units at that latitude
 *   and lowered by the geoid height, so the ellipsoidal heights sit on the map's ground.
 *
 *   A city spans a few kilometers, where this linear frame stays within a few
 *   centimeters of the true projection.
 *
 *   The three.js camera takes MapLibre's projection matrix as its own, and its view matrix
 *   is the rest of MapLibre's mercator matrix composed with that frame. 3DTilesRendererJS
 *   then picks tiles by their screen-space error on the map's real camera,
 *   and the models write the same depth values as the map's own layers.
 */

import { TilesRenderer } from "3d-tiles-renderer"
import { GLTFExtensionsPlugin } from "3d-tiles-renderer/plugins"
import type { CityTileset } from "@mailwoman/structures/city-tilesets"
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl"
import { Matrix4, PerspectiveCamera, Scene, WebGLRenderer } from "three"
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js"
import dracoWasmURL from "three/examples/jsm/libs/draco/draco_decoder.wasm?url"
import dracoWrapperURL from "three/examples/jsm/libs/draco/draco_wasm_wrapper.js?url"

import { bytesPerTileset, type ThreeDBudget } from "#memory/device-tier"

import { EARTH_CIRCUMFERENCE, mercatorWorld } from "../mercator-world.ts"
import { type CityFrame, cityFrame, createCityModelMaterial, styleCityModel } from "./style.ts"

/**
 * The lowest map zoom the layer draws at.
 */
const MIN_ZOOM = 14

/**
 * Above this globe-to-mercator transition the map draws as a globe, where the
 * layer's flat frame wouldn't line up, so the layer waits.
 * Street zooms are fully mercator.
 */
const MAX_PROJECTION_TRANSITION = 0.01

/**
 * The layer's id in the map style.
 */
export const CITY_MODELS_LAYER_ID = "city-models"

/**
 * A city tileset in use: its renderer and the matrix from its ECEF coordinates to the mercator world.
 */
interface ActiveCity {
	city: CityTileset
	tiles: TilesRenderer
	scene: Scene
	ecefToMercator: Matrix4
	loaded: boolean
}

/**
 * The matrix from ECEF meters to MapLibre's mercator world (x east and y south in 0..1,
 * z up in mercator units) in a local frame at `longitude`, `latitude` and ellipsoid height `height`.
 */
function ecefToMercatorMatrix({ origin, east, north, up, longitude, latitude }: CityFrame): Matrix4 {
	const [x, y] = mercatorWorld(longitude, latitude)
	const k = 1 / (EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180))

	// Rows: east, north (negated, since mercator y grows south) and up, each scaled to mercator units.
	const rotation = new Matrix4().set(
		east.x * k,
		east.y * k,
		east.z * k,
		0,
		-north.x * k,
		-north.y * k,
		-north.z * k,
		0,
		up.x * k,
		up.y * k,
		up.z * k,
		0,
		0,
		0,
		0,
		1
	)

	return new Matrix4()
		.makeTranslation(x, y, 0)
		.multiply(rotation)
		.multiply(new Matrix4().makeTranslation(origin.clone().negate()))
}

/**
 * Whether `[west, south, east, north]` meets the map's visible bounds.
 */
function inView(map: MapLibreMap, [west, south, east, north]: CityTileset["bounds"]): boolean {
	const bounds = map.getBounds()

	return (
		west <= bounds.getEast() && east >= bounds.getWest() && south <= bounds.getNorth() && north >= bounds.getSouth()
	)
}

export class CityModelsLayer implements CustomLayerInterface {
	readonly id = CITY_MODELS_LAYER_ID
	readonly type = "custom"
	readonly renderingMode = "3d"

	#cities: readonly CityTileset[]
	#tilesetURL: (city: CityTileset) => string
	#onCoverage: (cities: readonly CityTileset[]) => void
	#map: MapLibreMap | null = null
	#renderer: WebGLRenderer | null = null
	#camera = new PerspectiveCamera()
	#draco = new DRACOLoader().setDecoderPath({ js: dracoWrapperURL, wasm: dracoWasmURL })
	#material = createCityModelMaterial()
	#active = new Map<string, ActiveCity>()
	#covered = ""
	#budget: ThreeDBudget
	#activating = true

	/**
	 * @param cities The converted tilesets the layer may draw.
	 * @param tilesetURL The URL of a tileset's root `tileset.json`.
	 * @param onCoverage Called with the tilesets that have drawn a model,
	 * so other layers can stop drawing beneath them.
	 * @param budget The bytes of decoded geometry and textures the cities' tile caches share.
	 * A desktop gives each city 512 MiB.
	 * At zoom 17 and 60 degrees pitch over Tokyo Station that holds the view's 124 Chiyoda tiles,
	 * leaves and ancestors, with textures at most 1,024 pixels on a side.
	 */
	constructor(
		cities: readonly CityTileset[],
		tilesetURL: (city: CityTileset) => string,
		onCoverage: (cities: readonly CityTileset[]) => void,
		budget: ThreeDBudget
	) {
		this.#cities = cities
		this.#tilesetURL = tilesetURL
		this.#onCoverage = onCoverage
		this.#budget = budget
		this.#camera.matrixAutoUpdate = false
		this.#camera.matrixWorldAutoUpdate = false
	}

	onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
		this.#map = map
		this.#renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl })

		this.#renderer.autoClear = false
		// For measurement: each active tileset's renderer counters, such as tiles loaded, visible and refused by a full
		// cache.
		;(globalThis as { __mailwomanCityModels?: () => unknown }).__mailwomanCityModels = () =>
			[...this.#active.values()].map(({ city, tiles }) => ({
				id: city.id,
				stats: Reflect.get(tiles, "stats"),
				loadProgress: tiles.loadProgress,
			}))
	}

	onRemove(): void {
		for (const city of this.#active.values()) {
			city.tiles.dispose()
		}

		this.#active.clear()
		this.#draco.dispose()
		this.#material.dispose()
		this.#renderer?.dispose()
		this.#renderer = null
		this.#map = null
	}

	#activate(city: CityTileset): ActiveCity {
		const tiles = new TilesRenderer(this.#tilesetURL(city))

		// A view near the ground refines to leaf tiles, and the leaves in view
		// nearly fill the cache's byte budget.
		// Siblings outside the view would take the room the visible leaves need.
		tiles.loadSiblings = false
		tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.#draco, metadata: true }))
		const scene = new Scene()

		scene.add(tiles.group)

		const [west, south, east, north] = city.bounds
		// The frame's origin sits on the ellipsoid at the geoid height, so the models stand on the map's ground.
		const frame = cityFrame((west + east) / 2, (south + north) / 2, city.geoidHeight)

		const active: ActiveCity = {
			city,
			tiles,
			scene,
			ecefToMercator: ecefToMercatorMatrix(frame),
			loaded: false,
		}

		tiles.addEventListener("load-model", ({ scene: model }) => {
			styleCityModel(model, frame, this.#material)
			active.loaded = true
			this.#map?.triggerRepaint()
		})

		tiles.addEventListener("load-tile-set", () => this.#map?.triggerRepaint())

		tiles.addEventListener("load-error", ({ url, error }) => {
			console.warn(`[mailwoman earth] city model tile ${String(url)} failed`, error)
		})

		return active
	}

	/**
	 * Pauses or resumes loading a city that enters the view.
	 *
	 * Cities already loaded keep drawing and refining.
	 */
	setActivating(activating: boolean): void {
		this.#activating = activating

		if (activating) {
			this.#map?.triggerRepaint()
		}
	}

	/**
	 * Divides the budget among the active cities' tile caches.
	 */
	#shareBudget(): void {
		const bytes = bytesPerTileset(this.#budget, this.#active.size)

		for (const { tiles } of this.#active.values()) {
			tiles.lruCache.maxBytesSize = bytes
			tiles.lruCache.minBytesSize = bytes * 0.75
		}
	}

	#reportCoverage(): void {
		const covered = [...this.#active.values()].filter((active) => active.loaded).map((active) => active.city)
		const key = covered.map((city) => city.id).join(",")

		if (key === this.#covered) return
		this.#covered = key
		this.#onCoverage(covered)
	}

	render(gl: WebGL2RenderingContext | WebGLRenderingContext, args: CustomRenderMethodInput): void {
		const map = this.#map
		const renderer = this.#renderer

		if (!map || !renderer || !(gl instanceof WebGL2RenderingContext)) return

		const projection = args.defaultProjectionData
		const drawing = map.getZoom() >= MIN_ZOOM && projection.projectionTransition <= MAX_PROJECTION_TRANSITION

		for (const city of this.#cities) {
			const wanted = drawing && inView(map, city.bounds)
			const active = this.#active.get(city.id)

			if (wanted && !active && this.#activating) {
				this.#active.set(city.id, this.#activate(city))
				this.#shareBudget()
			}

			if (!wanted && active) {
				active.tiles.dispose()
				this.#active.delete(city.id)
				this.#shareBudget()
			}
		}

		this.#reportCoverage()

		if (!drawing || !this.#active.size) return

		const mercatorToClip = new Matrix4().fromArray(Array.from(projection.fallbackMatrix))
		const projectionMatrix = new Matrix4().fromArray(Array.from(args.projectionMatrix))
		const projectionInverse = projectionMatrix.clone().invert()
		const camera = this.#camera

		renderer.resetState()

		for (const active of this.#active.values()) {
			// MapLibre's view space for these points is view = P⁻¹ · (mercator → clip) · (ECEF → mercator).
			// It is in MapLibre's own units per meter and mirrored on one axis.
			// 3DTilesRendererJS culls and measures distance in view space, so its view
			// matrix must be a rotation and translation in meters.
			// The uniform scale and the mirror therefore move into the projection matrix.
			const view = projectionInverse.clone().multiply(mercatorToClip).multiply(active.ecefToMercator)
			const determinant = view.determinant()
			const scale = Math.cbrt(Math.abs(determinant))
			const scaleAndMirror = new Matrix4().makeScale(determinant < 0 ? -scale : scale, scale, scale)

			camera.matrixWorldInverse.copy(scaleAndMirror.clone().invert().multiply(view))
			camera.matrixWorld.copy(camera.matrixWorldInverse).invert()
			camera.matrix.copy(camera.matrixWorld)

			// The division by the scale keeps every normalized device coordinate.
			// It also returns element 5 to the field-of-view term.
			// The renderer reads that term to convert geometric error to pixels.
			camera.projectionMatrix
				.copy(projectionMatrix)
				.multiply(scaleAndMirror)
				.multiplyScalar(1 / scale)

			camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
			active.tiles.setCamera(camera)
			active.tiles.setResolution(camera, gl.drawingBufferWidth, gl.drawingBufferHeight)
			active.tiles.update()
			renderer.render(active.scene, camera)
		}

		renderer.resetState()
	}
}
