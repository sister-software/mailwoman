/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure MapLibre helpers for the demo page — basemap source fetch and the crisp-polygon DB opener.
 *   Consumed by the docs runtime (`_runtime.ts`) that feeds `@mailwoman/react/map`'s declarative
 *   `<GeocoderDemo>` overlays. The resolved-place geometry math lives in `@mailwoman/react/map/geometry`.
 *
 *   None of these touch React — they compute geometry or open a range-loaded DB; the map itself is now
 *   driven declaratively by the package, so the old imperative source/layer drawing helpers are gone.
 */

import type { VectorSourceSpecification } from "maplibre-gl"

/**
 * Origin of the tile worker serving basemap and overlay tiles. CORS-restricted to localhost and the docs domains.
 */
export const TILE_WORKER_URL = "https://tiles.mailwoman.ai"
/**
 * TileJSON the map reads before requesting basemap tiles.
 */
export const BASEMAP_TILEJSON_URL = `${TILE_WORKER_URL}/basemap-v4.json`

/**
 * A GeoJSON Polygon / MultiPolygon — what the polygon DB stores and the map draws as the place outline.
 */
export type PlaceGeometry =
	| { type: "Polygon"; coordinates: number[][][] }
	| { type: "MultiPolygon"; coordinates: number[][][][] }

/**
 * Id → simplified admin geometry, backed by the lazily-loaded `wof-polygons.db`. Async (range-loaded).
 */
export interface PolygonDB {
	get(id: number): Promise<PlaceGeometry | null>
}

/**
 * Open the crisp-polygon DB (built by scripts/build-wof-polygons.mjs) via sql.js-httpvfs — a single `SELECT geom WHERE
 * id=?` touches ~1 page, so the browser fetches a few KB of the 19 MB file rather than the whole thing. Same range-load
 * path as the resolver DB.
 */
export async function loadPolygonDB(url: string, sqljsBaseURL: string): Promise<PolygonDB> {
	const { loadHTTPVFSDatabase, makeHTTPVFSPolygonLookup } = await import("#shared/httpvfs-resolver")
	const worker = await loadHTTPVFSDatabase(url, sqljsBaseURL)
	const lookup = makeHTTPVFSPolygonLookup(worker)

	return {
		get: (id: number) => lookup.get(id) as Promise<PlaceGeometry | null>,
	}
}

/**
 * Fetch + normalize the protomaps v4 basemap tilejson into a MapLibre vector source spec.
 */
export async function fetchBasemapSource(): Promise<VectorSourceSpecification> {
	const response = await fetch(BASEMAP_TILEJSON_URL)

	if (!response.ok) {
		throw new Error(`Failed to load basemap tilejson (${response.status})`)
	}

	const meta = (await response.json()) as {
		scheme?: string
		tiles: string[]
		minzoom?: number
		maxzoom?: number
		attribution?: string
		bounds?: [number, number, number, number]
	}

	return {
		type: "vector",
		scheme: meta.scheme as VectorSourceSpecification["scheme"],
		tiles: meta.tiles,
		minzoom: meta.minzoom,
		maxzoom: meta.maxzoom,
		attribution: meta.attribution,
		bounds: meta.bounds,
	}
}
