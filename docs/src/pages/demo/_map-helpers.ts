/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure MapLibre helpers for the demo page — basemap source fetch, resolved-place outline drawing
 *   (crisp polygon, approximate circle), bbox math, and the style-ready gate. Extracted from
 *   `index.tsx` so the page component carries React/state concerns only and these stay
 *   independently unit-testable (see `map-helpers.test.ts`).
 *
 *   None of these touch React — they take a `MapLibreMap` (or plain coordinates) and mutate the map
 *   or compute geometry.
 */

import type { Map as MapLibreMap, VectorSourceSpecification } from "maplibre-gl"

export const TILE_WORKER_URL = "https://tiles.sister.software"
export const BASEMAP_TILEJSON_URL = `${TILE_WORKER_URL}/basemap-v4.json`

const BBOX_SOURCE = "mailwoman-bbox"
const BBOX_FILL_LAYER = "mailwoman-bbox-fill"
const BBOX_LINE_LAYER = "mailwoman-bbox-line"

/**
 * AddSource / addLayer / removeLayer / removeSource all throw "Style is not done loading" if called too early. Every
 * state-mutating call funnels through here so the initial-load and post-setStyle paths never race.
 */
export function whenStyleReady(map: MapLibreMap, fn: () => void): void {
	if (map.isStyleLoaded()) {
		fn()

		return
	}
	map.once("styledata", () => whenStyleReady(map, fn))
}

/**
 * A GeoJSON Polygon / MultiPolygon — what the polygon DB stores and the map draws as the place outline.
 */
export type PlaceGeometry =
	| { type: "Polygon"; coordinates: number[][][] }
	| { type: "MultiPolygon"; coordinates: number[][][][] }

/**
 * Shared source/layer plumbing for the resolved-place outline. Both the bbox rectangle and the crisp admin polygon
 * funnel through here so they reuse one source (`setData` swaps the geometry in place).
 */
function setPlaceOutline(map: MapLibreMap, geometry: PlaceGeometry): void {
	const geojson = {
		type: "FeatureCollection" as const,
		features: [{ type: "Feature" as const, geometry, properties: {} }],
	}
	whenStyleReady(map, () => {
		const existing = map.getSource(BBOX_SOURCE) as { setData?: (g: unknown) => void } | undefined

		if (existing && typeof existing.setData === "function") {
			existing.setData(geojson)

			return
		}
		map.addSource(BBOX_SOURCE, { type: "geojson", data: geojson })
		map.addLayer({
			id: BBOX_FILL_LAYER,
			type: "fill",
			source: BBOX_SOURCE,
			paint: { "fill-color": "#e0367c", "fill-opacity": 0.12 },
		})
		map.addLayer({
			id: BBOX_LINE_LAYER,
			type: "line",
			source: BBOX_SOURCE,
			paint: { "line-color": "#e0367c", "line-width": 2 },
		})
	})
}

/**
 * Approximate-extent circle for places without a crisp polygon: centered on the place point, radius from the bbox
 * half-diagonal (clamped 0.5–50 km). 64-point GeoJSON ring with latitude correction — visually a circle anywhere
 * outside the poles.
 */
export function drawApproxCircle(
	map: MapLibreMap,
	lat: number,
	lon: number,
	bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
): void {
	setPlaceOutline(map, approxCircleGeometry(lat, lon, bbox))
}

/**
 * The 64-point ring used by {@link drawApproxCircle}, split out so the geometry math can be unit tested without a live
 * map.
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

/**
 * A circle of an EXACT radius in meters — for the street-level uncertainty (#377): a 10 m situs floor or a calibrated
 * interp radius. Unlike {@link approxCircleGeometry} (clamped to a ~ZIP-sized 0.5 km floor for admin fallbacks), this
 * honors small radii so an exact building reads as a tight dot.
 */
export function radiusCircleGeometry(lat: number, lon: number, radiusM: number): PlaceGeometry {
	const kmPerDegLat = 111.32
	const kmPerDegLon = kmPerDegLat * Math.cos((lat * Math.PI) / 180)
	const radiusKm = Math.max(0.008, radiusM / 1000) // ~8 m min so a 10 m situs circle is still visible
	const ring: number[][] = []

	for (let i = 0; i <= 64; i++) {
		const theta = (2 * Math.PI * i) / 64
		ring.push([lon + (radiusKm * Math.cos(theta)) / kmPerDegLon, lat + (radiusKm * Math.sin(theta)) / kmPerDegLat])
	}

	return { type: "Polygon", coordinates: [ring] }
}

/** Draw a street-level uncertainty circle (exact meter radius) around a situs/interp coordinate. */
export function drawRadiusCircle(map: MapLibreMap, lat: number, lon: number, radiusM: number): void {
	setPlaceOutline(map, radiusCircleGeometry(lat, lon, radiusM))
}

/** Draw the crisp admin polygon straight from the polygon DB's GeoJSON geometry. */
export function drawPlaceGeometry(map: MapLibreMap, geometry: PlaceGeometry): void {
	setPlaceOutline(map, geometry)
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

			if (lon < minLon) minLon = lon

			if (lon > maxLon) maxLon = lon

			if (lat < minLat) minLat = lat

			if (lat > maxLat) maxLat = lat

			return
		}

		if (Array.isArray(node)) for (const child of node) visit(child)
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

/** Tear down the resolved-place outline (layers + source) once the style is ready. */
export function clearBbox(map: MapLibreMap): void {
	whenStyleReady(map, () => {
		if (map.getLayer(BBOX_FILL_LAYER)) map.removeLayer(BBOX_FILL_LAYER)

		if (map.getLayer(BBOX_LINE_LAYER)) map.removeLayer(BBOX_LINE_LAYER)

		if (map.getSource(BBOX_SOURCE)) map.removeSource(BBOX_SOURCE)
	})
}

/** Read Docusaurus's current color mode straight off the `<html data-theme>` attribute. */
export function currentDocusaurusTheme(): "light" | "dark" {
	if (typeof document === "undefined") return "light"

	return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
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
