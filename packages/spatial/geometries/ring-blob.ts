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
 *   `polygonIndex` IS required AND CANNOT BE INFERRED. A source feature is a MultiPolygon, so its
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

import type { MultiPolygonRings } from "#geometries/polygon"

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
 * Signed spherical area of one linear ring, in square metres. **CLOCKWISE is positive**, counter-clockwise negative.
 *
 * The sign is the whole point: an orientation-respecting sum over a polygon's rings subtracts its holes, while a sum of
 * absolute values adds them. Comparing the two against the source's own area figure is what tells a builder whether it
 * has read the holes at all — the failure mode is silent, because a hole read as an exterior ring produces a perfectly
 * well-formed polygon that simply covers more ground than the authority mapped.
 *
 * WHICH WINDING IS POSITIVE IS A CONTRACT, NOT A DETAIL, because a builder whose source encodes hole roles by
 * ORIENTATION reads roles off this sign. It is the opposite of the standard planar shoelace: this sum runs `(lonᵢ −
 * lonⱼ)` against the shoelace's `(xⱼ − xᵢ)`, so a ring `@mailwoman/spatial`'s own {@link rectangleRing} builds
 * counter-clockwise answers NEGATIVE here. `@mailwoman/zoning` is the caller that depends on it, and
 * `packages/zoning/test/unit/ring-roles.test.ts` pins the sign directly.
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
 * A rectangle in CRS84 degrees.
 */
export interface DegreeExtent {
	minLon: number
	minLat: number
	maxLon: number
	maxLat: number
}

/**
 * Refuse a feature whose reprojected vertices fall outside the publisher's own declared extent.
 *
 * THE CHECK A PROJECTION CHECK CANNOT MAKE. A swapped coordinate order survives an authority-code comparison — both
 * axes are still numbers in a plausible range — and a source read in its own metres as if they were degrees produces
 * perfectly well-formed coordinates in the wrong ocean. Both show up here on the first feature, before a whole layer is
 * written to the wrong side of the planet.
 *
 * SHARED BY EVERY POLYGON INGEST, because it is rectangle arithmetic over the ring types and knows nothing about any
 * product. `marginDegrees` is the caller's, because a declared extent is itself a rounded published value and how
 * tightly a source hugs its own is a fact about that source.
 *
 * @param context Names the calling ingest in the refusal, so a build log says which layer stopped.
 * @throws {RangeError} On the first vertex outside the extent.
 */
export function assertRingsInsideExtent(
	polygons: MultiPolygonRings,
	label: string,
	extent: DegreeExtent,
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
 * A point INSIDE one stored polygon, for a verification sampler.
 *
 * The bounding-box centre is tried first; where it is not inside — a crescent, a band hugging a river, a polygon with a
 * hole through its middle — a small deterministic grid over the box is scanned. A polygon no grid point lands inside is
 * refused (`undefined`) rather than approximated, because a sample point that is not actually inside the polygon turns
 * an agreement check into a check on the sampler.
 *
 * SHARED BY EVERY POLYGON LAYER'S VERIFY, because it is bounding-box arithmetic over the ring blob and knows nothing
 * about any product. `gridSteps` is the one thing that differs between them: a layer whose polygons are narrow strips
 * needs a finer grid than one whose polygons are compact, and the value is part of a layer's sampling receipt — two
 * runs of the same layer must draw the same points, so it is a caller's choice rather than a shared default nobody
 * owns.
 *
 * @param gridSteps Grid divisions per axis. Only `steps − 1` interior lines are tested, so 7 gives a 6 × 6 grid.
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
 * Whether a stored polygon's precomputed bounding box contains the point — the ray cast's prefilter, so the blob is
 * only pulled off disk for a polygon that could contain the point.
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
 * A reproducible sample of interior points drawn by a deterministic STRIDE over a key list — the shape every polygon
 * layer's verification sampler shares.
 *
 * The keys are chosen before any geometry is read: selecting them alone is an index-only walk over the primary key, and
 * the rows they name are then fetched by key. The draw is deterministic rather than random, so a re-run compares the
 * same points and a disagreement can be looked at rather than re-rolled.
 *
 * @param options.gridSteps The interior-point search depth, per {@link interiorPointOfEncodedRings} — part of a layer's
 *   sampling receipt, so it is a caller's choice rather than a shared default nobody owns.
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
