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

import { type FileHandle, open } from "@mailwoman/platform/fs/promises"
import { Parser } from "htmlparser2"
import { PMTiles, type RangeResponse, type Source } from "pmtiles"

import { type DecodedLayer, decodeMVT } from "./mvt.ts"

export interface DecodedTile {
	layers: DecodedLayer[]
}

/**
 * What a renderer needs from a tile archive — the read surface of {@link TileSource}, separated so a renderer can be
 * driven by any provider: a single archive, a stub in tests, or a composite over several archives.
 */
export interface TileProvider {
	readonly minZoom: number
	readonly maxZoom: number
	readonly attribution: string
	getTile(z: number, x: number, y: number): Promise<DecodedTile | null>
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
 * Plain-text attribution out of archive metadata (HTML tags stripped, entities decoded); empty string when absent.
 */
export function readAttribution(metadata: unknown): string {
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		!("attribution" in metadata) ||
		typeof (metadata as { attribution: unknown }).attribution !== "string"
	) {
		return ""
	}

	return htmlText((metadata as { attribution: string }).attribution)
}

/**
 * Plain text out of an HTML fragment via `htmlparser2`'s event parser — a hand scan misreads `<` inside attribute
 * values and unclosed tags, and the parser's own entity decoding covers the full named set a metadata field can carry.
 * Local rather than `@mailwoman/core`'s `htmlToText`: this package stays standalone by design, and one attribution
 * string does not price core's shipped data into every consumer.
 */
function htmlText(html: string): string {
	let text = ""

	const parser = new Parser({ ontext: (chunk) => (text += chunk) }, { decodeEntities: true })

	parser.write(html)
	parser.end()

	return text.replaceAll(/\s+/gu, " ").trim()
}

/**
 * A single LRU cache slot. Wrapping the decoded tile in an object lets `getTile` tell "cached and known absent" (`{
 * tile: null }`) apart from "not yet cached" (no entry in the Map) using plain presence, with no comparison against
 * `undefined` needed.
 */
interface CacheEntry {
	tile: DecodedTile | null
}

export class TileSource implements TileProvider, AsyncDisposable {
	readonly minZoom: number
	readonly maxZoom: number

	/**
	 * Plain-text attribution from archive metadata (HTML tags stripped); empty string when absent.
	 */
	readonly attribution: string

	/**
	 * Null for HTTP sources — fetch connections have no handle to hold or close.
	 */
	private readonly handle: FileHandle | null
	private readonly pmtiles: PMTiles
	private readonly cache = new Map<string, CacheEntry>()

	private constructor(
		handle: FileHandle | null,
		pmtiles: PMTiles,
		minZoom: number,
		maxZoom: number,
		attribution: string
	) {
		this.handle = handle
		this.pmtiles = pmtiles
		this.minZoom = minZoom
		this.maxZoom = maxZoom
		this.attribution = attribution
	}

	/**
	 * Opens a local `.pmtiles` path, or an `http(s)://` URL read via range requests — a hosted archive needs no tile
	 * server, only a host honoring `Range` (any static file server or object store does).
	 */
	static async open(pathOrURL: string): Promise<TileSource> {
		if (/^https?:\/\//u.test(pathOrURL)) {
			const pmtiles = new PMTiles(pathOrURL)
			const [header, metadata] = await Promise.all([pmtiles.getHeader(), pmtiles.getMetadata()])

			return new TileSource(null, pmtiles, header.minZoom, header.maxZoom, readAttribution(metadata))
		}

		const handle = await open(pathOrURL, "r")
		const pmtiles = new PMTiles(new FilePMTilesSource(pathOrURL, handle))

		const [header, metadata] = await Promise.all([pmtiles.getHeader(), pmtiles.getMetadata()])

		return new TileSource(handle, pmtiles, header.minZoom, header.maxZoom, readAttribution(metadata))
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

	async [Symbol.asyncDispose](): Promise<void> {
		await this.handle?.[Symbol.asyncDispose]()
	}
}
