/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure map geometry for the geocoder demo — the resolved-place outline math, lifted verbatim from the
 *   docs demo's `_map-helpers.ts`. Zero imports: no React, no `react-map-gl`, no `maplibre-gl`, no DOM.
 *   Every function takes plain numbers and returns plain GeoJSON, so the whole module runs (and is
 *   tested) under bare node — see `geometry.node.test.ts`.
 *
 *   WHY NOT `@mailwoman/spatial`: the only truly-spatial primitive here is the bbox half-diagonal (a
 *   great-circle-ish distance). `@mailwoman/spatial` exposes `haversineKm`, but ONLY via its root barrel,
 *   which pulls `@mailwoman/core` + `h3-js` + `wkx` — a heavy, partly node-only graph — into what must
 *   stay a lightweight, browser-only map bundle (the `@mailwoman/react/map` subpath). The original
 *   `_map-helpers.ts` made the same call: a planar `kmPerDeg` approximation, local, no dependency. We
 *   preserve it so the ported behavior is byte-identical and the browser graph stays clean.
 */

/** Mean km per degree of latitude (WGS84 average). */
const KM_PER_DEG_LAT = 111.32

/** A GeoJSON Polygon / MultiPolygon — what the polygon DB stores and the map draws as the place outline. */
export type PlaceGeometry =
	| { type: "Polygon"; coordinates: number[][][] }
	| { type: "MultiPolygon"; coordinates: number[][][][] }

/** A place bounding box in the demo's object form (the WOF points DB carries only these four numbers). */
export interface PlaceBBox {
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
}

/** A `[west, south, east, north]` → `[[minLon, minLat], [maxLon, maxLat]]` pair, the shape `fitBounds` wants. */
export type BoundsTuple = [[number, number], [number, number]]

/** Km per degree of longitude at a given latitude — the meridians converge toward the poles. */
function kmPerDegLon(lat: number): number {
	return KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
}

/** A closed 64-segment (65-point) GeoJSON ring of `radiusKm` around `[lon, lat]`, with latitude correction. */
function circleRing(lat: number, lon: number, radiusKm: number): number[][] {
	const perLon = kmPerDegLon(lat)
	const ring: number[][] = []

	for (let i = 0; i <= 64; i++) {
		const theta = (2 * Math.PI * i) / 64

		ring.push([lon + (radiusKm * Math.cos(theta)) / perLon, lat + (radiusKm * Math.sin(theta)) / KM_PER_DEG_LAT])
	}

	return ring
}

/**
 * Approximate-extent circle for places without a crisp polygon: centered on the place point, radius from the bbox
 * half-diagonal (clamped 0.5–50 km). 64-point ring with latitude correction — visually a circle anywhere outside the
 * poles. With no bbox (anchor-centroid postcodes carry no extent) it defaults to a ~ZIP-sized 3 km radius.
 */
export function approxCircleGeometry(lat: number, lon: number, bbox?: PlaceBBox): PlaceGeometry {
	const halfDiagKm = bbox
		? Math.hypot((bbox.maxLat - bbox.minLat) * KM_PER_DEG_LAT, (bbox.maxLon - bbox.minLon) * kmPerDegLon(lat)) / 2
		: 3
	const radiusKm = Math.min(50, Math.max(0.5, halfDiagKm))

	return { type: "Polygon", coordinates: [circleRing(lat, lon, radiusKm)] }
}

/**
 * A circle of an EXACT radius in meters — for the street-level uncertainty (#377): a 10 m situs floor or a calibrated
 * interp radius. Unlike {@link approxCircleGeometry} (clamped to a ~ZIP-sized 0.5 km floor for admin fallbacks), this
 * honors small radii so an exact building reads as a tight dot (an ~8 m floor keeps a 10 m situs circle visible).
 */
export function radiusCircleGeometry(lat: number, lon: number, radiusM: number): PlaceGeometry {
	const radiusKm = Math.max(0.008, radiusM / 1000)

	return { type: "Polygon", coordinates: [circleRing(lat, lon, radiusKm)] }
}

/**
 * Bounding box of a Polygon / MultiPolygon, for `fitBounds`. Walks the nested coordinate arrays, so it handles both a
 * single-ring polygon and a multi-part polygon uniformly. Antimeridian-crossing geometry is NOT normalized (the naive
 * min/max is returned) — matching the ported behavior; callers that need a wrapped bbox must handle it upstream.
 */
export function geomBounds(geometry: PlaceGeometry): PlaceBBox {
	let minLon = Infinity
	let minLat = Infinity
	let maxLon = -Infinity
	let maxLat = -Infinity

	const visit = (node: unknown): void => {
		if (Array.isArray(node) && typeof node[0] === "number" && typeof node[1] === "number") {
			const lon: number = node[0]
			const lat: number = node[1]

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

/** Reshape a {@link PlaceBBox} into the `[[minLon, minLat], [maxLon, maxLat]]` pair `fitBounds` expects. */
export function bboxToBounds(bbox: PlaceBBox): BoundsTuple {
	return [
		[bbox.minLon, bbox.minLat],
		[bbox.maxLon, bbox.maxLat],
	]
}
