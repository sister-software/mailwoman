/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

const CIRCLE_SEGMENTS = 64

const KM_PER_DEG_LAT = 111.32

/**
 * A GeoJSON Polygon / MultiPolygon — what the polygon DB stores and the map draws as the place outline.
 */
export type PlaceGeometry =
	| { type: "Polygon"; coordinates: number[][][] }
	| { type: "MultiPolygon"; coordinates: number[][][][] }

/**
 * A place bounding box in the demo's object form (the WOF points DB carries only these four numbers).
 */
export interface PlaceBBox {
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
}

/**
 * A `[west, south, east, north]` → `[[minLon, minLat], [maxLon, maxLat]]` pair, the shape `fitBounds` wants.
 */
export type BoundsTuple = [[number, number], [number, number]]

function kmPerDegLon(lat: number): number {
	return KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
}

function circleRing(lat: number, lon: number, radiusKM: number): number[][] {
	const perLon = kmPerDegLon(lat)
	const ring: number[][] = []

	for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
		const theta = (2 * Math.PI * i) / 64

		ring.push([lon + (radiusKM * Math.cos(theta)) / perLon, lat + (radiusKM * Math.sin(theta)) / KM_PER_DEG_LAT])
	}

	return ring
}

/**
 * Returns a circle approximating the extent of a place that has no polygon, with a radius
 * of half the bbox diagonal clamped to 0.5–50 km, or 3 km when there is no bbox.
 */
export function approxCircleGeometry(lat: number, lon: number, bbox?: PlaceBBox): PlaceGeometry {
	const halfDiagKm = bbox
		? Math.hypot((bbox.maxLat - bbox.minLat) * KM_PER_DEG_LAT, (bbox.maxLon - bbox.minLon) * kmPerDegLon(lat)) / 2
		: 3

	const radiusKM = Math.min(50, Math.max(0.5, halfDiagKm))

	return { type: "Polygon", coordinates: [circleRing(lat, lon, radiusKM)] }
}

/**
 * Returns a circle with the given radius in meters for street-level uncertainty, floored at 8 m
 * so that a precise point stays visible, unlike {@link approxCircleGeometry}'s 0.5 km floor.
 */
export function radiusCircleGeometry(lat: number, lon: number, radiusM: number): PlaceGeometry {
	const radiusKM = Math.max(0.008, radiusM / 1000)

	return { type: "Polygon", coordinates: [circleRing(lat, lon, radiusKM)] }
}

/**
 * Returns the bounding box of a Polygon or MultiPolygon for `fitBounds`.
 *
 * Geometry that crosses the antimeridian gets a naive min/max box, so callers
 * that need a wrapped box must handle it themselves.
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

/**
 * Reshape a {@link PlaceBBox} into the `[[minLon, minLat], [maxLon, maxLat]]` pair `fitBounds` expects.
 */
export function bboxToBounds(bbox: PlaceBBox): BoundsTuple {
	return [
		[bbox.minLon, bbox.minLat],
		[bbox.maxLon, bbox.maxLat],
	]
}
