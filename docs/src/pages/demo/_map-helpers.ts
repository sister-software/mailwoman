/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure MapLibre helpers for the demo page — basemap source fetch, approximate-extent circle geometry,
 *   bbox math, and the crisp-polygon DB opener. Consumed by the docs runtime (`_runtime.ts`) that feeds
 *   `@mailwoman/react/map`'s declarative `<GeocoderDemo>` overlays, and unit-tested in
 *   `map-helpers.test.ts`.
 *
 *   None of these touch React — they compute geometry or open a range-loaded DB; the map itself is now
 *   driven declaratively by the package, so the old imperative source/layer drawing helpers are gone.
 */

import type { VectorSourceSpecification } from "maplibre-gl"

export const TILE_WORKER_URL = "https://tiles.sister.software"
export const BASEMAP_TILEJSON_URL = `${TILE_WORKER_URL}/basemap-v4.json`

/**
 * A GeoJSON Polygon / MultiPolygon — what the polygon DB stores and the map draws as the place outline.
 */
export type PlaceGeometry =
	| { type: "Polygon"; coordinates: number[][][] }
	| { type: "MultiPolygon"; coordinates: number[][][][] }

/**
 * The 64-point approximate-extent ring for places without a crisp polygon: centered on the place point, radius from the
 * bbox half-diagonal (clamped 0.5–50 km), with latitude correction — visually a circle anywhere outside the poles.
 */
export function approxCircleGeometry(
	lat: number,
	lon: number,
	bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
): PlaceGeometry {
	const kmPerDegLat = 111.32
	const kmPerDegLon = kmPerDegLat * Math.cos((lat * Math.PI) / 180)
	const halfDiagKm = bbox
		? Math.hypot((bbox.maxLat - bbox.minLat) * kmPerDegLat, (bbox.maxLon - bbox.minLon) * kmPerDegLon) / 2
		: 3 // anchor-centroid postcodes carry no extent; ~ZIP-sized default
	const radiusKm = Math.min(50, Math.max(0.5, halfDiagKm))
	const ring: number[][] = []

	for (let i = 0; i <= 64; i++) {
		const theta = (2 * Math.PI * i) / 64
		ring.push([lon + (radiusKm * Math.cos(theta)) / kmPerDegLon, lat + (radiusKm * Math.sin(theta)) / kmPerDegLat])
	}

	return { type: "Polygon", coordinates: [ring] }
}

/** Bounding box of a Polygon / MultiPolygon, for fitBounds. Walks the nested coordinate arrays. */
export function geomBounds(geometry: PlaceGeometry): {
	minLon: number
	minLat: number
	maxLon: number
	maxLat: number
} {
	let minLon = Infinity
	let minLat = Infinity
	let maxLon = -Infinity
	let maxLat = -Infinity
	const visit = (node: unknown): void => {
		if (Array.isArray(node) && typeof node[0] === "number") {
			const [lon, lat] = node as number[]

			if (lon < minLon) {
				minLon = lon
			}

			if (lon > maxLon) {
				maxLon = lon
			}

			if (lat < minLat) {
				minLat = lat
			}

			if (lat > maxLat) {
				maxLat = lat
			}

			return
		}

		if (Array.isArray(node)) {
			for (const child of node) {
				visit(child)
			}
		}
	}
	visit(geometry.coordinates)

	return { minLon, minLat, maxLon, maxLat }
}

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
	const { loadHTTPVFSDatabase, makeHTTPVFSPolygonLookup } = await import("../../shared/httpvfs-resolver")
	const worker = await loadHTTPVFSDatabase(url, sqljsBaseURL)
	const lookup = makeHTTPVFSPolygonLookup(worker)

	return {
		get: (id: number) => lookup.get(id) as Promise<PlaceGeometry | null>,
	}
}

/** Fetch + normalize the protomaps v4 basemap tilejson into a MapLibre vector source spec. */
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
