/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * PMTiles archive reader for map-tui.
 *
 * TileSource wraps a local `.pmtiles` file (node:fs/promises FileHandle) behind the pmtiles `Source` interface, decodes
 * each requested tile's MVT payload via ./mvt.ts, and keeps a small LRU cache of decoded tiles so repeated draws of the
 * same viewport don't re-decode.
 */

import { type FileHandle, open } from "node:fs/promises"

import { PMTiles, type RangeResponse, type Source } from "pmtiles"

import { type DecodedLayer, decodeMVT } from "./mvt.ts"

export interface DecodedTile {
	layers: DecodedLayer[]
}

class FilePMTilesSource implements Source {
	private readonly path: string
	private readonly handle: FileHandle

	constructor(path: string, handle: FileHandle) {
		this.path = path
		this.handle = handle
	}

	getKey(): string {
		return this.path
	}

	async getBytes(offset: number, length: number): Promise<RangeResponse> {
		const buffer = Buffer.alloc(length)
		const { bytesRead } = await this.handle.read(buffer, 0, length, offset)

		return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) }
	}
}

const TILE_CACHE_LIMIT = 64

/**
 * A single LRU cache slot. Wrapping the decoded tile in an object lets `getTile` tell "cached and known absent" (`{
 * tile: null }`) apart from "not yet cached" (no entry in the Map) using plain presence, with no comparison against
 * `undefined` needed.
 */
interface CacheEntry {
	tile: DecodedTile | null
}

export class TileSource {
	readonly minZoom: number
	readonly maxZoom: number

	/**
	 * Plain-text attribution from archive metadata (HTML tags stripped); empty string when absent.
	 */
	readonly attribution: string

	private readonly handle: FileHandle
	private readonly pmtiles: PMTiles
	private readonly cache = new Map<string, CacheEntry>()

	private constructor(handle: FileHandle, pmtiles: PMTiles, minZoom: number, maxZoom: number, attribution: string) {
		this.handle = handle
		this.pmtiles = pmtiles
		this.minZoom = minZoom
		this.maxZoom = maxZoom
		this.attribution = attribution
	}

	static async open(path: string): Promise<TileSource> {
		const handle = await open(path, "r")
		const pmtiles = new PMTiles(new FilePMTilesSource(path, handle))

		const [header, metadata] = await Promise.all([pmtiles.getHeader(), pmtiles.getMetadata()])

		const attribution =
			typeof metadata === "object" &&
			metadata !== null &&
			"attribution" in metadata &&
			typeof (metadata as { attribution: unknown }).attribution === "string"
				? (metadata as { attribution: string }).attribution.replaceAll(/<[^>]+>/gu, "").trim()
				: ""

		return new TileSource(handle, pmtiles, header.minZoom, header.maxZoom, attribution)
	}

	/**
	 * Decoded tile, LRU-cached (64 entries). null = tile absent from the archive.
	 */
	async getTile(z: number, x: number, y: number): Promise<DecodedTile | null> {
		const key = `${z}/${x}/${y}`
		const cached = this.cache.get(key)

		if (cached != null) {
			// Refresh recency by re-inserting at the end of iteration order.
			this.cache.delete(key)
			this.cache.set(key, cached)

			return cached.tile
		}

		const response = await this.pmtiles.getZxy(z, x, y)

		const tile: DecodedTile | null = response != null ? { layers: decodeMVT(new Uint8Array(response.data)) } : null

		this.cache.set(key, { tile })

		if (this.cache.size > TILE_CACHE_LIMIT) {
			const oldestKey = this.cache.keys().next().value

			if (typeof oldestKey === "string") {
				this.cache.delete(oldestKey)
			}
		}

		return tile
	}

	async close(): Promise<void> {
		await this.handle.close()
	}
}
