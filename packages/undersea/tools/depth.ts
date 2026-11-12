// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads a depth for each undersea feature from the terrarium elevation tiles the map draws.
 *
 *   The GEBCO service records no depth.
 *   The tiles hold NOAA ETOPO1 bathymetry offshore, at about 1.8 km per sample,
 *   so a depth here is the grid's value near the feature rather than a surveyed sounding.
 *
 *   The feature's generic term decides whether it gets a depth: a deep, trench or basin
 *   reports its deepest sample, and {@link depthKindOf} states why a rise gets none.
 */

import sharp from "sharp"

import type { UnderseaDepthKind } from "#features"

/**
 * The terrarium tiles, served by the tile worker from the AWS Terrain Tiles.
 */
const TERRARIUM_TILE_URL = "https://tiles.mailwoman.post/terrain/terrarium/{z}/{x}/{y}.png"

/**
 * The zoom the depths are read at: about 600 m per pixel at the equator,
 * finer than the ETOPO1 grid behind it.
 */
export const DEPTH_ZOOM = 8

const TILE_SIZE = 256

/**
 * Pixels read on each side of a point, so a point's window spans about 4 km at the equator.
 *
 * A gazetteer coordinate marks the feature by eye on a chart, and the grid's extreme can sit a sample away.
 */
const POINT_WINDOW_PX = 3

/**
 * Tiles fetched at once.
 */
const FETCH_CONCURRENCY = 8

/**
 * The status the tile server answers where it has no tile.
 * The reader treats it as no data there.
 */
const HTTP_NOT_FOUND = 404

/**
 * Features between progress lines.
 */
const PROGRESS_EVERY = 1000

/**
 * Generic terms whose depth is the deepest sample: depressions in the sea floor.
 */
const DEEPEST_TERMS = new Set([
	"deep",
	"deeps",
	"hole",
	"trench",
	"trough",
	"basin",
	"abyssal plain",
	"plain",
	"canyon",
	"canyons",
	"valley",
	"valleys",
	"sea valley",
	"sea valleys",
	"caldera",
	"calderas",
])

/**
 * Which extreme stands for a feature with this generic term, or `null`
 * when the layer records no depth for it.
 *
 * Only depressions get a depth.
 * The grid resolves a trench floor within about 2% (Challenger Deep reads −10,763 m
 * against about −10,920 m surveyed), but it smooths a narrow summit away.
 *
 * The top of Vema Seamount is about 11 m below the surface, and the grid reads −1,206 m there.
 *
 * A seamount, bank or ridge therefore records no depth rather than a summit depth off by a kilometer.
 */
export function depthKindOf(genericTerm: string): UnderseaDepthKind | null {
	return DEEPEST_TERMS.has(genericTerm.trim().toLowerCase()) ? "deepest" : null
}

/**
 * A feature's sample positions, `[lon, lat]`, and whether each one is a single point to widen into a window.
 */
export interface DepthSampleRequest {
	positions: ReadonlyArray<readonly [number, number]>
	/**
	 * True when the positions are points whose surroundings should be searched.
	 * A line's vertices are read as they're.
	 */
	window: boolean
	kind: UnderseaDepthKind
}

/**
 * The global pixel coordinate of a position at {@link DEPTH_ZOOM}.
 */
function globalPixel(lon: number, lat: number): [number, number] {
	const scale = TILE_SIZE * 2 ** DEPTH_ZOOM
	const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat))
	const sin = Math.sin((clampedLat * Math.PI) / 180)

	return [
		Math.floor(((lon + 180) / 360) * scale),
		Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale),
	]
}

/**
 * The elevation a terrarium pixel encodes, in meters.
 */
function terrariumElevation(red: number, green: number, blue: number): number {
	return red * 256 + green + blue / 256 - 32_768
}

/**
 * Decoded terrarium tiles, fetched once each.
 */
export class TerrariumReader {
	readonly #tiles = new Map<string, Promise<Uint8Array | null>>()
	readonly #tileURL: string

	constructor(tileURL: string = TERRARIUM_TILE_URL) {
		this.#tileURL = tileURL
	}

	/**
	 * The number of tiles fetched or in flight.
	 */
	get tileCount(): number {
		return this.#tiles.size
	}

	/**
	 * The RGB pixels of one tile, or `null` when the tile server has no tile there.
	 */
	#tile(x: number, y: number): Promise<Uint8Array | null> {
		const key = `${x}/${y}`
		const held = this.#tiles.get(key)

		if (held) return held

		const url = this.#tileURL.replace("{z}", String(DEPTH_ZOOM)).replace("{x}", String(x)).replace("{y}", String(y))

		const load = fetch(url).then(async (response) => {
			if (response.status === HTTP_NOT_FOUND) return null

			if (!response.ok) throw new Error(`terrarium tile ${url} answered ${response.status}`)

			const { data } = await sharp(new Uint8Array(await response.arrayBuffer()))
				.removeAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true })

			return new Uint8Array(data)
		})

		this.#tiles.set(key, load)

		return load
	}

	/**
	 * The elevation at a global pixel, or `null` when its tile is missing.
	 */
	async elevationAt(globalX: number, globalY: number): Promise<number | null> {
		const span = TILE_SIZE * 2 ** DEPTH_ZOOM
		const x = ((globalX % span) + span) % span
		const y = Math.max(0, Math.min(span - 1, globalY))
		const pixels = await this.#tile(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE))

		if (!pixels) return null

		const offset = ((y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)) * 3

		return terrariumElevation(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!)
	}

	/**
	 * The feature's depth below sea level in meters, as a negative elevation, or `null`
	 * when every sample is at or above sea level or no tile covers it.
	 */
	async depthOf(request: DepthSampleRequest): Promise<number | null> {
		const pixels: Array<[number, number]> = []

		for (const [lon, lat] of request.positions) {
			const [x, y] = globalPixel(lon, lat)

			if (!request.window) {
				pixels.push([x, y])

				continue
			}

			for (let dy = -POINT_WINDOW_PX; dy <= POINT_WINDOW_PX; dy++) {
				for (let dx = -POINT_WINDOW_PX; dx <= POINT_WINDOW_PX; dx++) {
					pixels.push([x + dx, y + dy])
				}
			}
		}

		const elevations = (await Promise.all(pixels.map(([x, y]) => this.elevationAt(x, y)))).filter(
			(value): value is number => value !== null && value < 0
		)

		if (!elevations.length) return null

		const extreme = request.kind === "deepest" ? Math.min(...elevations) : Math.max(...elevations)

		return Math.round(extreme)
	}
}

/**
 * Reads the depth of every request, {@link FETCH_CONCURRENCY} features at a time.
 */
export async function readDepths(
	requests: ReadonlyArray<DepthSampleRequest | null>,
	reader: TerrariumReader = new TerrariumReader(),
	log?: (line: string) => void
): Promise<Array<number | null>> {
	const depths: Array<number | null> = Array.from({ length: requests.length }, () => null)
	let next = 0

	const worker = async () => {
		while (next < requests.length) {
			const index = next++
			const request = requests[index]

			if (request) {
				depths[index] = await reader.depthOf(request)
			}

			if ((index + 1) % PROGRESS_EVERY === 0) {
				log?.(`depths: ${index + 1}/${requests.length} features, ${reader.tileCount} tiles`)
			}
		}
	}

	await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker))

	return depths
}
