/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A MapLibre custom layer that draws converted city models, 3D Tiles 1.1 served by the tile worker, with
 *   3DTilesRendererJS and three.js on the map's own WebGL context and depth buffer.
 *
 *   The tiles are in Earth-centered coordinates (ECEF). For each tileset the layer builds the matrix from ECEF to
 *   MapLibre's mercator world: a local east-north-up frame at the tileset's center, scaled to mercator units at that
 *   latitude and lowered by the geoid height, so the ellipsoidal heights sit on the map's ground. A city spans a few
 *   kilometers, where this linear frame stays within a few centimeters of the true projection.
 *
 *   The three.js camera takes MapLibre's projection matrix as its own, and its view matrix is the rest of MapLibre's
 *   mercator matrix composed with that frame. 3DTilesRendererJS then picks tiles by their screen-space error on the
 *   map's real camera, and the models write the same depth values as the map's own layers.
 */

import { TilesRenderer } from "3d-tiles-renderer"
import { GLTFExtensionsPlugin } from "3d-tiles-renderer/plugins"
import type { CityTileset } from "@mailwoman/structures/city-tilesets"
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl"
import { AmbientLight, DirectionalLight, Matrix4, PerspectiveCamera, Scene, WebGLRenderer } from "three"
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js"
import dracoWasmURL from "three/examples/jsm/libs/draco/draco_decoder.wasm?url"
import dracoWrapperURL from "three/examples/jsm/libs/draco/draco_wasm_wrapper.js?url"

import { EARTH_CIRCUMFERENCE, mercatorWorld } from "../mercator-world.ts"

/**
 * The lowest map zoom the layer draws at.
 */
const MIN_ZOOM = 14

/**
 * The WGS84 ellipsoid's semi-major axis and first eccentricity squared.
 */
const WGS84_A = 6_378_137
const WGS84_E2 = 6.69437999014e-3

/**
 * Above this globe-to-mercator transition the map draws as a globe, where the
 * layer's flat frame would not line up, so the layer waits.
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
function ecefToMercatorMatrix(longitude: number, latitude: number, height: number): Matrix4 {
	const λ = (longitude * Math.PI) / 180
	const φ = (latitude * Math.PI) / 180
	const [sinλ, cosλ, sinφ, cosφ] = [Math.sin(λ), Math.cos(λ), Math.sin(φ), Math.cos(φ)]
	const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinφ * sinφ)
	const origin = [(n + height) * cosφ * cosλ, (n + height) * cosφ * sinλ, (n * (1 - WGS84_E2) + height) * sinφ]
	const [x, y] = mercatorWorld(longitude, latitude)
	const k = 1 / (EARTH_CIRCUMFERENCE * cosφ)

	// Rows: east, north (negated, since mercator y grows south) and up, each scaled to mercator units.
	const rotation = new Matrix4().set(
		-sinλ * k,
		cosλ * k,
		0,
		0,
		sinφ * cosλ * k,
		sinφ * sinλ * k,
		-cosφ * k,
		0,
		cosφ * cosλ * k,
		cosφ * sinλ * k,
		sinφ * k,
		0,
		0,
		0,
		0,
		1
	)

	return new Matrix4()
		.makeTranslation(x, y, 0)
		.multiply(rotation)
		.multiply(new Matrix4().makeTranslation(-origin[0]!, -origin[1]!, -origin[2]!))
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
	#active = new Map<string, ActiveCity>()
	#covered = ""

	/**
	 * @param cities The converted tilesets the layer may draw.
	 * @param tilesetURL The URL of a tileset's root `tileset.json`.
	 * @param onCoverage Called with the tilesets that have drawn a model,
	 * so other layers can stop drawing beneath them.
	 */
	constructor(
		cities: readonly CityTileset[],
		tilesetURL: (city: CityTileset) => string,
		onCoverage: (cities: readonly CityTileset[]) => void
	) {
		this.#cities = cities
		this.#tilesetURL = tilesetURL
		this.#onCoverage = onCoverage
		this.#camera.matrixAutoUpdate = false
		this.#camera.matrixWorldAutoUpdate = false
	}

	onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
		this.#map = map
		this.#renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl })
		this.#renderer.autoClear = false
	}

	onRemove(): void {
		for (const city of this.#active.values()) {
			city.tiles.dispose()
		}

		this.#active.clear()
		this.#draco.dispose()
		this.#renderer?.dispose()
		this.#renderer = null
		this.#map = null
	}

	#activate(city: CityTileset): ActiveCity {
		const tiles = new TilesRenderer(this.#tilesetURL(city))

		tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.#draco, metadata: true }))
		const scene = new Scene()

		scene.add(new AmbientLight(0xff_ff_ff, 1.6))
		const sun = new DirectionalLight(0xff_ff_ff, 1.4)

		// The light comes from above, toward the north-west, in ECEF at the tileset's center.
		sun.position.copy(tiles.group.position).set(-0.4, 0.6, 0.7)
		scene.add(sun)
		scene.add(tiles.group)

		const [west, south, east, north] = city.bounds

		const active: ActiveCity = {
			city,
			tiles,
			scene,
			ecefToMercator: ecefToMercatorMatrix((west + east) / 2, (south + north) / 2, city.geoidHeight),
			loaded: false,
		}

		tiles.addEventListener("load-model", () => {
			active.loaded = true
			this.#map?.triggerRepaint()
		})

		tiles.addEventListener("load-tile-set", () => this.#map?.triggerRepaint())

		return active
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

			if (wanted && !active) {
				this.#active.set(city.id, this.#activate(city))
			}

			if (!wanted && active) {
				active.tiles.dispose()
				this.#active.delete(city.id)
			}
		}

		this.#reportCoverage()

		if (!drawing || !this.#active.size) return

		const mercatorToClip = new Matrix4().fromArray(Array.from(projection.fallbackMatrix))
		const projectionMatrix = new Matrix4().fromArray(Array.from(args.projectionMatrix))
		const projectionInverse = projectionMatrix.clone().invert()
		const camera = this.#camera

		camera.projectionMatrix.copy(projectionMatrix)
		camera.projectionMatrixInverse.copy(projectionInverse)
		renderer.resetState()

		for (const active of this.#active.values()) {
			// view = P⁻¹ · (mercator → clip) · (ECEF → mercator), so P · view is MapLibre's own matrix for these points.
			camera.matrixWorldInverse.copy(projectionInverse).multiply(mercatorToClip).multiply(active.ecefToMercator)
			camera.matrixWorld.copy(camera.matrixWorldInverse).invert()
			camera.matrix.copy(camera.matrixWorld)
			active.tiles.setCamera(camera)
			active.tiles.setResolution(camera, gl.drawingBufferWidth, gl.drawingBufferHeight)
			active.tiles.update()
			renderer.render(active.scene, camera)
		}

		renderer.resetState()
	}
}
