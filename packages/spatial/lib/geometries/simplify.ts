/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Simplifies a polygon or multipolygon by Douglas-Peucker over each ring, for a place boundary drawn on a map.
 */

import { roundCoordinate } from "#geometries/round"

type Position = [number, number, ...number[]]

type Ring = Position[]

/**
 * A polygon or multipolygon geometry, as GeoJSON holds it.
 */
export type AreaGeometry = { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] }

/**
 * The fewest positions a closed ring can hold.
 */
const MIN_RING_POSITIONS = 4

/**
 * The positions a ring keeps when the tolerance collapses it.
 */
const COLLAPSED_RING_POSITIONS = 8

const squaredDistanceToSegment = ([x, y]: Position, [ax, ay]: Position, [bx, by]: Position): number => {
	const dx = bx - ax
	const dy = by - ay
	const length = dx * dx + dy * dy
	const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length))

	return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2
}

/**
 * Lists a ring's kept positions, with an explicit stack so a ring of a million
 * positions cannot overflow the call stack.
 */
function simplifyRing(ring: Ring, tolerance: number): Ring {
	const keep = new Uint8Array(ring.length)
	const last = ring.length - 1

	// A closed ring's end points coincide, so the farthest position from the start also anchors the split.
	let anchor = 0
	let farthest = -1

	for (let i = 1; i < last; i++) {
		const distance = squaredDistanceToSegment(ring[i]!, ring[0]!, ring[0]!)

		if (distance > farthest) {
			farthest = distance
			anchor = i
		}
	}

	keep[0] = keep[last] = keep[anchor] = 1

	const stack: Array<[number, number]> = [
		[0, anchor],
		[anchor, last],
	]

	const squaredTolerance = tolerance * tolerance

	while (stack.length) {
		const [start, end] = stack.pop()!
		let worst = -1
		let worstDistance = squaredTolerance

		for (let i = start + 1; i < end; i++) {
			const distance = squaredDistanceToSegment(ring[i]!, ring[start]!, ring[end]!)

			if (distance > worstDistance) {
				worst = i
				worstDistance = distance
			}
		}

		if (worst !== -1) {
			keep[worst] = 1
			stack.push([start, worst], [worst, end])
		}
	}

	return ring.filter((_, i) => keep[i] === 1)
}

/**
 * Returns a closed ring of evenly spaced positions from a ring too small to simplify.
 */
function sampleRing(ring: Ring): Ring {
	if (ring.length <= COLLAPSED_RING_POSITIONS) return ring

	const last = ring.length - 1
	const steps = COLLAPSED_RING_POSITIONS - 1

	return Array.from({ length: COLLAPSED_RING_POSITIONS }, (_, step) => ring[Math.round((step * last) / steps)]!)
}

/**
 * Simplifies each ring and rounds its positions to two dimensions at the given precision.
 *
 * A polygon whose outer ring collapses below a closed ring keeps a few evenly spaced
 * positions from that ring, so a small island still draws at a bounded size.
 * An inner ring that collapses drops.
 */
export function simplifyAreaGeometry(geometry: AreaGeometry, tolerance: number, decimals = 5): AreaGeometry {
	const polygon = (rings: Ring[]): Ring[] =>
		rings.flatMap((ring, index) => {
			const simplified = ring.length > MIN_RING_POSITIONS ? simplifyRing(ring, tolerance) : ring

			const kept = simplified.length >= MIN_RING_POSITIONS ? simplified : index === 0 ? sampleRing(ring) : null

			return kept
				? [kept.map(([lon, lat]): Position => [roundCoordinate(lon, decimals), roundCoordinate(lat, decimals)])]
				: []
		})

	return geometry.type === "Polygon"
		? { type: "Polygon", coordinates: polygon(geometry.coordinates) }
		: { type: "MultiPolygon", coordinates: geometry.coordinates.map(polygon) }
}
