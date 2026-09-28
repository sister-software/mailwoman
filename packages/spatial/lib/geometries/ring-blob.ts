/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A polygon layer's stored ring blob: an 8-byte header, then a `(u32 pointCount, u32 polygonIndex)`
 *   pair per ring, then `[lon, lat]` pairs on an 8-byte boundary so the reader takes a
 *   `Float64Array` view; `polygonIndex` is required because one feature's rings belong to several polygons.
 */

import type { LatLonBounds } from "#bbox"
import type { MultiPolygonRings } from "#geometries/polygon"

/**
 * Format version stamped into every blob, rejected by a reader that meets a different number.
 */
export const RING_BLOB_VERSION = 1

const HEADER_BYTES = 8

const RING_ENTRY_BYTES = 8

/**
 * Positions a linear ring needs to bound an area: three distinct vertices plus
 * the repeat that closes it (RFC 7946 §3.1.6).
 */
const MINIMUM_RING_POSITIONS = 4

/**
 * One decoded feature: `[exteriorRing, ...holes]` per polygon, each ring a
 * flat `[lon, lat, lon, lat, …]` run.
 */
export interface DecodedRings {
	polygons: number[][][]
}

/**
 * Pack a GeoJSON `MultiPolygon`/`Polygon` coordinate tree into the stored blob, throwing
 * when the geometry carries no ring or a ring carries fewer than four positions.
 */
export function encodeRings(polygons: MultiPolygonRings): Uint8Array {
	const entries: Array<{ pointCount: number; polygonIndex: number }> = []
	let totalPoints = 0

	for (const [polygonIndex, rings] of polygons.entries()) {
		for (const ring of rings) {
			if (ring.length < MINIMUM_RING_POSITIONS) {
				throw new RangeError(
					`ring blob: a linear ring needs at least ${MINIMUM_RING_POSITIONS} positions, got ${ring.length}`
				)
			}

			entries.push({ pointCount: ring.length, polygonIndex })
			totalPoints += ring.length
		}
	}

	if (!entries.length) {
		throw new RangeError("ring blob: geometry carries no ring")
	}

	const headerBytes = HEADER_BYTES + RING_ENTRY_BYTES * entries.length
	const buffer = new ArrayBuffer(headerBytes + totalPoints * 2 * Float64Array.BYTES_PER_ELEMENT)
	const view = new DataView(buffer)

	view.setUint32(0, RING_BLOB_VERSION, true)
	view.setUint32(4, entries.length, true)

	for (const [index, entry] of entries.entries()) {
		view.setUint32(HEADER_BYTES + index * RING_ENTRY_BYTES, entry.pointCount, true)
		view.setUint32(HEADER_BYTES + index * RING_ENTRY_BYTES + 4, entry.polygonIndex, true)
	}

	const coordinates = new Float64Array(buffer, headerBytes, totalPoints * 2)
	let cursor = 0

	for (const rings of polygons) {
		for (const ring of rings) {
			for (const position of ring) {
				coordinates[cursor++] = position[0]!
				coordinates[cursor++] = position[1]!
			}
		}
	}

	return new Uint8Array(buffer)
}

/**
 * The ring table plus a `Float64Array` over the coordinates, throwing when the blob's version is not
 * {@linkcode RING_BLOB_VERSION} or its declared ring table does not account for the bytes present.
 */
function openRings(blob: Uint8Array): {
	ringCount: number
	pointCounts: Uint32Array
	polygonIndices: Uint32Array
	coordinates: Float64Array
} {
	// `blob.byteOffset` is not always zero: node:sqlite hands back a view into a shared buffer.
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
	const version = view.getUint32(0, true)

	if (version !== RING_BLOB_VERSION) {
		throw new Error(`ring blob: blob version ${version}, expected ${RING_BLOB_VERSION}`)
	}

	const ringCount = view.getUint32(4, true)
	const headerBytes = HEADER_BYTES + RING_ENTRY_BYTES * ringCount
	const pointCounts = new Uint32Array(ringCount)
	const polygonIndices = new Uint32Array(ringCount)
	let totalPoints = 0

	for (let index = 0; index < ringCount; index++) {
		const pointCount = view.getUint32(HEADER_BYTES + index * RING_ENTRY_BYTES, true)

		pointCounts[index] = pointCount
		polygonIndices[index] = view.getUint32(HEADER_BYTES + index * RING_ENTRY_BYTES + 4, true)
		totalPoints += pointCount
	}

	const expected = headerBytes + totalPoints * 2 * Float64Array.BYTES_PER_ELEMENT

	if (expected !== blob.byteLength) {
		throw new Error(`ring blob: blob declares ${expected} bytes of geometry, holds ${blob.byteLength}`)
	}

	// The header is a multiple of eight by construction, so the coordinate run is 8-byte
	// aligned; a misaligned source buffer is copied rather than rejected.
	const absoluteOffset = blob.byteOffset + headerBytes

	const coordinates =
		absoluteOffset % Float64Array.BYTES_PER_ELEMENT === 0
			? new Float64Array(blob.buffer, absoluteOffset, totalPoints * 2)
			: new Float64Array(blob.slice(headerBytes).buffer, 0, totalPoints * 2)

	return { ringCount, pointCounts, polygonIndices, coordinates }
}

/**
 * Is the point inside the stored geometry, even-odd within each polygon's own ring list
 * and inside-any-polygon across them, without allocating the ring arrays.
 */
export function pointInEncodedRings(blob: Uint8Array, lon: number, lat: number): boolean {
	const { ringCount, pointCounts, polygonIndices, coordinates } = openRings(blob)

	if (!ringCount) return false

	let cursor = 0
	let polygon = polygonIndices[0]
	let inside = false

	for (let index = 0; index < ringCount; index++) {
		const pointCount = pointCounts[index]!

		if (polygonIndices[index] !== polygon) {
			if (inside) return true

			polygon = polygonIndices[index]
			inside = false
		}

		if (crossesOdd(coordinates, cursor, pointCount, lon, lat)) {
			inside = !inside
		}

		cursor += pointCount * 2
	}

	return inside
}

/**
 * The even-odd crossing count over one ring held in a flat coordinate run, mirroring
 * {@linkcode pointInRing} exactly so a decoded ring and an encoded one never disagree.
 */
function crossesOdd(coordinates: Float64Array, offset: number, pointCount: number, lon: number, lat: number): boolean {
	let inside = false

	for (let i = 0, j = pointCount - 1; i < pointCount; j = i++) {
		const xi = coordinates[offset + i * 2]!
		const yi = coordinates[offset + i * 2 + 1]!
		const xj = coordinates[offset + j * 2]!
		const yj = coordinates[offset + j * 2 + 1]!

		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside
		}
	}

	return inside
}

/**
 * Unpack the blob back into per-polygon flat coordinate runs.
 */
export function decodeRings(blob: Uint8Array): DecodedRings {
	const { ringCount, pointCounts, polygonIndices, coordinates } = openRings(blob)
	const polygons: number[][][] = []
	let cursor = 0

	for (let index = 0; index < ringCount; index++) {
		const pointCount = pointCounts[index]!
		const polygonIndex = polygonIndices[index]!

		polygons[polygonIndex] ??= []
		polygons[polygonIndex]!.push([...coordinates.subarray(cursor, cursor + pointCount * 2)])
		cursor += pointCount * 2
	}

	return { polygons }
}

/**
 * Mean Earth radius in metres, the sphere the ring areas are measured on.
 */
const EARTH_RADIUS_M = 6_371_008.8

/**
 * Signed spherical area of one linear ring, in square metres, with clockwise positive
 * and counter-clockwise negative.
 */
export function ringSignedAreaM2(ring: ReadonlyArray<readonly number[]>): number {
	let total = 0

	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [lonI, latI] = ring[i] as [number, number]
		const [lonJ, latJ] = ring[j] as [number, number]

		total +=
			(((lonI - lonJ) * Math.PI) / 180) * (2 + Math.sin((latJ * Math.PI) / 180) + Math.sin((latI * Math.PI) / 180))
	}

	return (total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2
}

/**
 * Both readings of one feature's area, in square metres: `nested` respects ring
 * orientation (holes subtract) and `allExterior` does not (holes add).
 */
export function ringAreaReadings(polygons: MultiPolygonRings): {
	nested: number
	allExterior: number
} {
	let nested = 0
	let allExterior = 0

	for (const rings of polygons) {
		// Per polygon rather than pooled, so two disjoint polygons wound opposite ways do not cancel out.
		let signedTotal = 0

		for (const ring of rings) {
			const signed = ringSignedAreaM2(ring)

			signedTotal += signed
			allExterior += Math.abs(signed)
		}

		nested += Math.abs(signedTotal)
	}

	return { nested, allExterior }
}

/**
 * Refuse a feature whose reprojected vertices fall outside the publisher's own
 * declared extent, throwing on the first vertex outside it.
 */
export function assertRingsInsideExtent(
	polygons: MultiPolygonRings,
	label: string,
	extent: LatLonBounds,
	marginDegrees: number,
	context = "polygon ingest"
): void {
	for (const rings of polygons) {
		for (const ring of rings) {
			for (const position of ring) {
				const lon = position[0]!
				const lat = position[1]!

				if (
					lon < extent.minLon - marginDegrees ||
					lon > extent.maxLon + marginDegrees ||
					lat < extent.minLat - marginDegrees ||
					lat > extent.maxLat + marginDegrees
				) {
					throw new RangeError(
						`${context}: ${label} has a vertex at ${lon}, ${lat}, outside the declared extent ` +
							`[${extent.minLon}, ${extent.minLat}, ${extent.maxLon}, ${extent.maxLat}] — the reprojection or the coordinate order is wrong`
					)
				}
			}
		}
	}
}

/**
 * One stored polygon's bounding box and geometry, as every polygon layer's truth table stores them.
 */
export interface EncodedArea {
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	rings: Uint8Array
}

/**
 * A point inside one stored polygon for a verification sampler, returning `undefined` when neither
 * the bounding-box centre nor any of the `gridSteps − 1` interior grid lines lands inside.
 */
export function interiorPointOfEncodedRings(
	area: EncodedArea,
	gridSteps = 7
): { latitude: number; longitude: number } | undefined {
	const centreLat = (area.min_lat + area.max_lat) / 2
	const centreLon = (area.min_lon + area.max_lon) / 2

	if (pointInEncodedRings(area.rings, centreLon, centreLat)) {
		return { latitude: centreLat, longitude: centreLon }
	}

	for (let row = 1; row < gridSteps; row++) {
		for (let column = 1; column < gridSteps; column++) {
			const latitude = area.min_lat + ((area.max_lat - area.min_lat) * row) / gridSteps
			const longitude = area.min_lon + ((area.max_lon - area.min_lon) * column) / gridSteps

			if (pointInEncodedRings(area.rings, longitude, latitude)) return { latitude, longitude }
		}
	}

	return undefined
}

/**
 * Whether a stored polygon's precomputed bounding box contains the point.
 */
export function bboxContains(
	bounds: Pick<EncodedArea, "min_lat" | "min_lon" | "max_lat" | "max_lon">,
	longitude: number,
	latitude: number
): boolean {
	return (
		longitude >= bounds.min_lon &&
		longitude <= bounds.max_lon &&
		latitude >= bounds.min_lat &&
		latitude <= bounds.max_lat
	)
}

/**
 * A reproducible sample of interior points drawn by a deterministic stride over a key list.
 */
export function strideSampleInteriorPoints<Area extends EncodedArea, Point>(
	keys: readonly string[],
	count: number,
	options: {
		fetch: (key: string) => Area | undefined
		gridSteps: number
		toPoint: (area: Area, interior: { latitude: number; longitude: number }) => Point
	}
): Point[] {
	const points: Point[] = []

	if (!keys.length) return points

	const stride = Math.max(1, Math.floor(keys.length / Math.max(1, count)))

	for (let index = 0; index < keys.length && points.length < count; index += stride) {
		const area = options.fetch(keys[index]!)

		if (!area) continue

		const interior = interiorPointOfEncodedRings(area, options.gridSteps)

		if (!interior) continue

		points.push(options.toPoint(area, interior))
	}

	return points
}

/**
 * The bounding rectangle of one feature's rings, in degrees — a ray cast's prefilter, precomputed.
 */
export function ringsBoundingBox(polygons: MultiPolygonRings): {
	minLat: number
	minLon: number
	maxLat: number
	maxLon: number
} {
	let minLat = Infinity
	let minLon = Infinity
	let maxLat = -Infinity
	let maxLon = -Infinity

	for (const rings of polygons) {
		for (const ring of rings) {
			for (const position of ring) {
				const lon = position[0]!
				const lat = position[1]!

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
			}
		}
	}

	return { minLat, minLon, maxLat, maxLon }
}
