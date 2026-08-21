/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The one geometry-to-point reduction shared by OSM address, POI, and sub-venue extractors.
 */

export interface OSMGeometryLike {
	type?: string
	coordinates?: unknown
}

function isFinitePair(lon: unknown, lat: unknown): lon is number {
	return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat)
}

/**
 * Reduce a GeoJSON geometry to one representative coordinate: the point itself, or the average of an exterior ring's
 * distinct vertices. The average is an intentionally cheap venue/rooftop-tier coordinate, not a polygon centroid.
 */
export function representativePoint(geom: OSMGeometryLike | null | undefined): [number, number] | null {
	if (!geom) return null

	if (geom.type === "Point") {
		const c = geom.coordinates as [number, number]

		return isFinitePair(c?.[0], c?.[1]) ? [c[0], c[1]] : null
	}

	const ring = (
		geom.type === "Polygon"
			? (geom.coordinates as number[][][])?.[0]
			: geom.type === "MultiPolygon"
				? (geom.coordinates as number[][][][])?.[0]?.[0]
				: null
	) as number[][] | null

	if (!ring || !ring.length) return null

	let vertexCount = ring.length

	if (vertexCount > 1 && ring[0]![0] === ring[vertexCount - 1]![0] && ring[0]![1] === ring[vertexCount - 1]![1]) {
		vertexCount--
	}

	let longitudeSum = 0
	let latitudeSum = 0

	for (let index = 0; index < vertexCount; index++) {
		longitudeSum += ring[index]![0]!
		latitudeSum += ring[index]![1]!
	}

	const longitude = longitudeSum / vertexCount
	const latitude = latitudeSum / vertexCount

	return isFinitePair(longitude, latitude) ? [longitude, latitude] : null
}
