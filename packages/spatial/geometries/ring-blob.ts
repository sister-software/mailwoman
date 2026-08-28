/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ring blob — how a polygon layer stores one authority feature's UNSIMPLIFIED coordinates, and the
 *   point test that reads it without materializing them.
 *
 *   THE GEOMETRY IS THE TRUTH TABLE. An H3 index above it answers a cell that lies wholly inside one
 *   feature; a cell a boundary crosses falls through to a ray cast against the few features the index
 *   already named. A rooftop answer at a boundary — which is where the answer usually matters most — has
 *   no other source, so the rings are stored at the resolution the authority published them and never
 *   simplified.
 *
 *   THE LAYOUT PUTS THE COORDINATES ON AN 8-BYTE BOUNDARY, so the reader takes a `Float64Array` view over
 *   them instead of a `DataView.getFloat64` per ordinate. Header is `u32 version`, `u32 ringCount`, then
 *   one `(u32 pointCount, u32 polygonIndex)` pair per ring — `8 + 8 × ringCount` bytes, a multiple of
 *   eight by construction. Coordinates follow as `[lon, lat]` pairs, ring by ring.
 *
 *   `polygonIndex` IS LOAD-BEARING AND CANNOT BE INFERRED. A source feature is a MultiPolygon, so its
 *   rings belong to several polygons and "the first ring is the exterior" is true only per polygon. The
 *   point test is orientation-free and nesting-free (even-odd across a polygon's own rings, the rule
 *   {@link pointInPolygon} uses), but it still has to know which rings share a polygon: an island sitting
 *   inside another polygon's hole is inside the layer and would cancel to "outside" if every ring were
 *   pooled into one list.
 *
 *   SHARED BY EVERY POLYGON LAYER RATHER THAN COPIED INTO EACH. `@mailwoman/flood` and `@mailwoman/soil`
 *   both store an authority's rings this way, and a second copy of the alignment arithmetic or of the
 *   signed-area reading would be a second thing to get right — both failure modes are silent, since a
 *   mis-read blob answers a containment question wrongly and a hole-blind area reading answers "inside"
 *   for every point in a hole.
 */

/**
 * Format version stamped into every blob. A reader that meets a different number throws rather than reinterpreting
 * bytes it does not know the shape of.
 */
export const RING_BLOB_VERSION = 1

/**
 * Bytes of fixed header before the per-ring table.
 */
const HEADER_BYTES = 8

/**
 * Bytes per ring-table entry: `u32 pointCount`, `u32 polygonIndex`.
 */
const RING_ENTRY_BYTES = 8

/**
 * Positions a linear ring needs to bound an area: three distinct vertices plus the repeat that closes it (RFC 7946
 * §3.1.6). Fewer is a degenerate ring, and encoding one would store a polygon no point can be inside.
 */
const MINIMUM_RING_POSITIONS = 4

/**
 * One polygon's rings: `[exterior, ...holes]`, each ring a list of `[lon, lat]` positions.
 */
export type PolygonRings = ReadonlyArray<ReadonlyArray<readonly number[]>>

/**
 * A feature's polygons — `MultiPolygon` coordinates, with a bare `Polygon` lifted into the same shape.
 */
export type MultiPolygonRings = ReadonlyArray<PolygonRings>

/**
 * One decoded feature: `[exteriorRing, ...holes]` per polygon, each ring a flat `[lon, lat, lon, lat, …]` run.
 */
export interface DecodedRings {
	/**
	 * `polygons[p][r]` is a flat coordinate run for ring `r` of polygon `p`.
	 */
	polygons: number[][][]
}

/**
 * Pack a GeoJSON `MultiPolygon`/`Polygon` coordinate tree into the stored blob.
 *
 * @throws {RangeError} When the geometry carries no ring, or a ring carries fewer than four positions (a linear ring is
 *   closed, so three is the minimum distinct-vertex count plus the repeat).
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
 * The ring table plus a `Float64Array` over the coordinates — what both the point test and the decoder walk.
 *
 * @throws {Error} When the blob's version is not {@linkcode RING_BLOB_VERSION}, or its declared ring table does not
 *   account for the bytes present. A blob that is silently mis-read answers a containment question wrongly, and a wrong
 *   containment answer is indistinguishable from a real one.
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

	// The header is a multiple of eight by construction, so the coordinate run is 8-byte aligned and this view is legal
	// on a shared buffer whose own offset is aligned. A misaligned source buffer is copied rather than rejected.
	const absoluteOffset = blob.byteOffset + headerBytes

	const coordinates =
		absoluteOffset % Float64Array.BYTES_PER_ELEMENT === 0
			? new Float64Array(blob.buffer, absoluteOffset, totalPoints * 2)
			: new Float64Array(blob.slice(headerBytes).buffer, 0, totalPoints * 2)

	return { ringCount, pointCounts, polygonIndices, coordinates }
}

/**
 * Is the point inside the stored geometry?
 *
 * Even-odd within each polygon's own ring list, inside-any-polygon across them — the orientation-free rule
 * {@linkcode pointInPolygon} states, applied without allocating the ring arrays. Reading a hole as an exterior ring is
 * what this rule survives: a point inside a hole crosses two rings and comes out even, whichever way either ring
 * winds.
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
 * The even-odd crossing count over one ring held in a flat coordinate run. Mirrors {@linkcode pointInRing} exactly —
 * same predicate, same tie behavior — so a decoded ring and an encoded one never disagree.
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
 * Unpack the blob back into per-polygon flat coordinate runs — for tests, for a debug render, and for the round-trip
 * check a build's fixtures assert.
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
 * Mean Earth radius in metres — the sphere the ring areas below are measured on.
 */
const EARTH_RADIUS_M = 6_371_008.8

/**
 * Signed spherical area of one linear ring, in square metres. Counter-clockwise is positive.
 *
 * The sign is the whole point: an orientation-respecting sum over a polygon's rings subtracts its holes, while a sum of
 * absolute values adds them. Comparing the two against the source's own area figure is what tells a builder whether it
 * has read the holes at all — the failure mode is silent, because a hole read as an exterior ring produces a perfectly
 * well-formed polygon that simply covers more ground than the authority mapped.
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
 * Both readings of one feature's area, in square metres: `nested` respects ring orientation (holes subtract) and
 * `allExterior` does not (holes add).
 *
 * A source whose holes are correctly nested makes `nested` match the authority's own figure and `allExterior` exceed
 * it. The gap between them is the area a hole-blind reader would answer "inside" for.
 */
export function ringAreaReadings(polygons: MultiPolygonRings): {
	nested: number
	allExterior: number
} {
	let nested = 0
	let allExterior = 0

	for (const rings of polygons) {
		// Per POLYGON, not pooled: two disjoint polygons of one feature can wind opposite ways without either being a
		// hole, and a pooled sum would silently cancel them against each other.
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
