/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolve which of a feature's rings are EXTERIORS and which are HOLES, from ring orientation — the one
 *   piece of this layer that no sibling builder already has, and the one whose absence is silent.
 *
 *   THE SERVICE ENCODES HOLE ROLES BY ORIENTATION RATHER THAN BY NESTING, AND IT DOES IT ON MOST FEATURES.
 *   Measured over the whole national export (85,330 features, 93,483 rings): 89,967 rings are clockwise and
 *   3,516 counter-clockwise; 84,021 features are wholly clockwise; and 1,309 features carry both windings.
 *   Of those, 1,210 nest their holes inside one polygon part the way RFC 7946 expects, and the rest put every
 *   ring in its own `MultiPolygon` part — the largest feature in the country, Meath's `RA - Rural Area`,
 *   arrives as 107 single-ring parts of which 5 are clockwise and 102 counter-clockwise. So the source uses
 *   BOTH encodings, the orientation is the only signal common to them, and a reader that took the nesting at
 *   face value would read 102 holes as 102 separate zoned areas.
 *
 *   CLOCKWISE IS EXTERIOR, WHICH IS THE INVERSE OF RFC 7946, AND THE PUBLISHER'S OWN ARITHMETIC PROVES IT.
 *   Summing every ring's signed area over the export gives 5,444.492956 km²; the Department's own
 *   `Shape__Area` column sums to 5,444.492956 km². Summing the same rings' ABSOLUTE areas gives 5,666.569
 *   km². The signed reading matches the publisher to eight significant figures and the absolute one is 4.1%
 *   too large, so the counter-clockwise rings subtract under the publisher's own accounting: they are holes.
 *
 *   THE HARMLESS HALF OF GETTING IT WRONG IS THE AREA. The harmful half is that a ray cast reading all 107 of
 *   Meath's rings as exteriors answers "inside `P5` rural zoning" for every location the plan carved out.
 *
 *   AND GDAL CANNOT BE ASKED TO PRESERVE THIS. Its GeoJSON writer enforces the RFC 7946 winding
 *   unconditionally — `-lco RFC7946=NO` is not a GeoJSONSeq option and `--config OGR_ORGANIZE_POLYGONS SKIP`
 *   changes nothing — so a reprojected GeoJSON stream returns Meath as 107 counter-clockwise exteriors
 *   totalling 2,371.9 km² against the Department's 2,232.1 km². The same conversion written as WKT keeps the
 *   source's 5/102 split intact, which is why `sdk/ingest.ts` streams WKT.
 */

import { pointInRing, ringSignedAreaM2, type MultiPolygonRings } from "@mailwoman/spatial"

/**
 * How many of a hole's vertices are tested against a candidate exterior.
 *
 * ONE VERTEX IS NOT ENOUGH, AND THAT WAS MEASURED. Holes in this product routinely share vertices with the exterior
 * they sit in, and a ray cast at a point exactly on an edge is implementation-defined — so a first-vertex test leaves
 * 26 of the 3,516 holes unplaced, while a majority vote over nine of their own vertices leaves 9. Every one of those 9
 * is a degenerate sliver of between 0.0008 m² and 1.7 m², and the publisher's own area accounting subtracts all of
 * them.
 */
const HOLE_VERTEX_SAMPLES = 9

/**
 * One feature's rings, with the publisher's own hole roles resolved.
 */
export interface ResolvedRingRoles {
	/**
	 * `[exterior, ...holes]` per polygon — the shape the ring blob stores and the point test reads.
	 */
	polygons: MultiPolygonRings
	exteriorCount: number
	holeCount: number
	/**
	 * Holes placed under an exterior that contains a majority of their sampled vertices.
	 */
	nestedHoles: number
	/**
	 * Holes NO exterior contains a majority of, placed under the smallest exterior of the same feature and counted here.
	 *
	 * Measured at 9 of 3,516 nationally, every one a sliver under 1.7 m² sitting on its parent's boundary. They are
	 * carried rather than dropped: the publisher's own area accounting subtracts them, so dropping one would add ground
	 * the plan carved out, and a feature with exactly one exterior — 8 of the 9 — has no ambiguity at all.
	 */
	adjacentHoles: number
	/**
	 * `1` where the feature's exterior was chosen by MAGNITUDE because no ring read as one by orientation.
	 *
	 * MEASURED AT ONE FEATURE OF 85,330, and its size is the reason the fallback exists rather than a refusal. `OBJECTID`
	 * 74040 — Galway County Council, `Agriculture` — is a single three-vertex ring enclosing 3.0 × 10⁻⁷ m², a third of a
	 * square micrometre. At that magnitude a ring's winding is floating-point noise rather than something the publisher
	 * stated: the same ring reads clockwise in the source's own Irish Transverse Mercator metres and counter-clockwise
	 * after reprojection. Refusing it would fail the build on the publisher's own data; dropping it would invent an
	 * absence. So the largest ring by magnitude becomes the exterior, which is also the correct reading for a feature
	 * published wholly inverted, and the count rides on the receipt rather than being implied to be zero.
	 */
	exteriorByMagnitude: number
	/**
	 * The signed ring sum over the source's rings AS PUBLISHED, in square metres — POSITIVE under this service's
	 * clockwise-exterior convention.
	 *
	 * The ingest's own receipt, stored on the row. It is what the build compares against the Department's `Shape__Area`
	 * sum, and its SIGN is the record that the orientation was read: a source that started publishing counter-clockwise
	 * exteriors would flip it, which is a fact about the source rather than a rounding difference.
	 */
	signedAreaM2: number
	ringCount: number
}

/**
 * Flatten a feature's rings, whichever way the source nested them.
 *
 * DELIBERATELY DISCARDS THE ARRIVING NESTING. Both encodings reach here — a properly nested polygon and a pile of
 * single-ring parts — and the orientation is the only signal that means the same thing in both. Keeping the nesting for
 * the features that have it and inferring it for the ones that do not would put two rules over one artifact.
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
 * @param featureID Named in every refusal, so a build log says which feature rather than only that one failed.
 * @throws {Error} When the feature carries no ring at all. That is the one case with no reading: a feature reduced to
 *   nothing reads downstream as an absence of zoning, which is the one answer this layer must never invent. A feature
 *   whose rings all read as holes DOES have a reading — see {@link ResolvedRingRoles.exteriorByMagnitude}.
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

		// CLOCKWISE IS EXTERIOR UNDER THIS SERVICE, and `ringSignedAreaM2` signs clockwise POSITIVE — see its docstring.
		// A zero-area ring is degenerate rather than either role, and is carried as a hole so it can never enclose anything.
		if (signed > 0) {
			exteriors.push({ ring, area: signed, holes: [] })
		} else {
			holes.push(ring)
		}
	}

	let exteriorByMagnitude = 0

	// NO RING READ AS AN EXTERIOR, SO MAGNITUDE DECIDES — measured at exactly one feature of 85,330. The largest ring is
	// the one that encloses the area, which is the correct reading both for a degenerate sliver whose winding is
	// floating-point noise and for a feature published wholly inverted. Refusing here would fail the build on the
	// publisher's own data, and skipping the feature would invent an absence.
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

	// SMALLEST CONTAINING EXTERIOR, so a hole inside an island inside a hole lands on the island rather than on the outer
	// ring. Sorting once is cheaper than choosing per hole, and it makes the choice deterministic on a tie.
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

		// A hole no exterior contains a majority of sits ON its parent's boundary — measured at 9 of 3,516 nationally, all
		// under 1.7 m². It goes to the smallest exterior of the same feature, which is the only exterior at all on 8 of the
		// 9, and is counted so a receipt can carry the number rather than imply it is zero.
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
