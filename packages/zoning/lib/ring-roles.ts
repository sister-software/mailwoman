/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Clockwise is exterior — the inverse of RFC 7946 — because the service encodes hole roles by
 *   orientation rather than nesting.
 */

import { pointInRing, ringSignedAreaM2, type MultiPolygonRings } from "@mailwoman/spatial"

/**
 * How many of a hole's vertices are tested against a candidate exterior.
 *
 * A hole and its exterior share vertices.
 * One vertex cannot distinguish them.
 * A ray cast on an edge is implementation-defined.
 */
const HOLE_VERTEX_SAMPLES = 9

/**
 * One feature's rings, with the publisher's own hole roles resolved.
 */
export interface ResolvedRingRoles {
	/**
	 * `[exterior, ...holes]` per polygon.
	 * The shape the ring blob stores and the point test reads.
	 */
	polygons: MultiPolygonRings
	exteriorCount: number
	holeCount: number
	/**
	 * Holes placed under an exterior that contains a majority of their sampled vertices.
	 */
	nestedHoles: number
	/**
	 * Holes no exterior contains a majority of, placed under the smallest exterior
	 * of the same feature and counted here: they are retained rather than dropped,
	 * because dropping one would add ground the plan carved out.
	 */
	adjacentHoles: number
	/**
	 * `1` where the feature's exterior was chosen by magnitude because no ring read as one by orientation.
	 *
	 * The largest ring becomes the exterior.
	 * This also handles a feature published wholly inverted.
	 * The receipt reports the count explicitly.
	 */
	exteriorByMagnitude: number
	/**
	 * The signed ring sum over the source's rings as published, in square metres,
	 * positive under this service's clockwise-exterior convention.
	 * Its sign is the record that the orientation was read.
	 */
	signedAreaM2: number
	ringCount: number
}

/**
 * Flatten a feature's rings, discarding the arriving nesting because orientation is
 * the only signal that means the same thing in both encodings.
 */
function flattenRings(polygons: MultiPolygonRings): ReadonlyArray<ReadonlyArray<readonly number[]>> {
	const rings: Array<ReadonlyArray<readonly number[]>> = []

	for (const part of polygons) {
		for (const ring of part) {
			rings.push(ring)
		}
	}

	return rings
}

/**
 * Does `outer` contain a majority of `ring`'s sampled vertices?
 */
function containsMajority(ring: ReadonlyArray<readonly number[]>, outer: ReadonlyArray<readonly number[]>): boolean {
	const stride = Math.max(1, Math.floor(ring.length / HOLE_VERTEX_SAMPLES))

	let inside = 0
	let tested = 0

	for (let index = 0; index < ring.length; index += stride) {
		tested++

		if (pointInRing(ring[index]![0]!, ring[index]![1]!, outer)) {
			inside++
		}
	}

	return inside * 2 > tested
}

/**
 * Resolve one feature's hole roles from ring orientation.
 *
 * @param featureID Included in every refusal, so a build log identifies which feature failed.
 * @throws {Error} When the feature has no ring at all, the one case with no reading.
 */
export function resolveRingRoles(polygons: MultiPolygonRings, featureID: string): ResolvedRingRoles {
	const rings = flattenRings(polygons)

	if (!rings.length) {
		throw new Error(`zoning rings: feature ${featureID} carries no ring`)
	}

	const exteriors: Array<{
		ring: ReadonlyArray<readonly number[]>
		area: number
		holes: Array<ReadonlyArray<readonly number[]>>
	}> = []

	const holes: Array<ReadonlyArray<readonly number[]>> = []

	let signedAreaM2 = 0

	for (const ring of rings) {
		const signed = ringSignedAreaM2(ring)

		signedAreaM2 += signed

		// `ringSignedAreaM2` signs clockwise positive.
		// This service treats clockwise rings as exteriors.
		// A zero-area ring is degenerate and stays a hole.
		// It cannot enclose anything.
		if (signed > 0) {
			exteriors.push({ ring, area: signed, holes: [] })
		} else {
			holes.push(ring)
		}
	}

	let exteriorByMagnitude = 0

	// No ring read as an exterior, so magnitude decides: the largest ring is the one that encloses the area.
	if (!exteriors.length) {
		let largestIndex = 0
		let largestArea = Math.abs(ringSignedAreaM2(holes[0]!))

		for (let index = 1; index < holes.length; index++) {
			const area = Math.abs(ringSignedAreaM2(holes[index]!))

			if (area > largestArea) {
				largestIndex = index
				largestArea = area
			}
		}

		const [largest] = holes.splice(largestIndex, 1)

		exteriors.push({ ring: largest!, area: largestArea, holes: [] })

		exteriorByMagnitude = 1
	}

	// Smallest containing exterior, so a hole inside an island inside a hole lands on the island.
	// One sort makes the choice deterministic on a tie.
	const bySize = [...exteriors].toSorted((left, right) => left.area - right.area)

	let nestedHoles = 0
	let adjacentHoles = 0

	for (const hole of holes) {
		const parent = bySize.find((exterior) => containsMajority(hole, exterior.ring))

		if (parent) {
			parent.holes.push(hole)

			nestedHoles++

			continue
		}

		// A hole no exterior contains a majority of sits on its parent's boundary and goes to the smallest
		// exterior of the same feature, so a receipt can report the number rather than imply it is zero.
		bySize[0]!.holes.push(hole)

		adjacentHoles++
	}

	return {
		polygons: exteriors.map((exterior) => [exterior.ring, ...exterior.holes]),
		exteriorCount: exteriors.length,
		holeCount: holes.length,
		nestedHoles,
		adjacentHoles,
		exteriorByMagnitude,
		signedAreaM2,
		ringCount: rings.length,
	}
}
