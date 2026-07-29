/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Position along a polyline, by arc length.
 *
 *   This is what house-number interpolation stands on: given a street segment's geometry and how far
 *   along its house-number range an address sits, it answers where that is on the ground. It lived in
 *   two byte-identical copies — `resolver-wof-sqlite/interpolation.ts` and the browser twin in
 *   `docs/src/shared/httpvfs-street.ts` — under a header telling both to be kept in lockstep by hand.
 *   The geometry never differed between them; only the I/O around it did.
 */

import { haversineKm } from "./position.ts"

/**
 * Clamp a fraction into `[0, 1]`.
 *
 * NaN passes through, which is deliberate: an interpolation whose inputs were not numbers should produce NaN
 * coordinates a caller can detect, not silently snap to a segment's start.
 */
export function clampFraction(t: number): number {
	return t < 0 ? 0 : Math.min(1, t)
}

/**
 * The point at fraction `t` of a polyline's total arc length (haversine), plus that total in km.
 *
 * `t` is assumed clamped to `[0, 1]`. A zero-length polyline yields its first vertex and a length of 0, so a degenerate
 * segment still produces a usable coordinate rather than NaN.
 */
export function pointAlong(
	polyline: readonly [number, number][],
	t: number
): [lon: number, lat: number, lengthKm: number] {
	const legs: number[] = []
	let total = 0

	for (let i = 1; i < polyline.length; i++) {
		const [aLon, aLat] = polyline[i - 1]!
		const [bLon, bLat] = polyline[i]!
		const d = haversineKm(aLat, aLon, bLat, bLon)
		legs.push(d)
		total += d
	}

	if (total === 0) {
		const [lon, lat] = polyline[0]!

		return [lon, lat, 0]
	}
	let remaining = t * total

	for (let i = 0; i < legs.length; i++) {
		const leg = legs[i]!

		if (remaining <= leg || i === legs.length - 1) {
			const f = leg === 0 ? 0 : clampFraction(remaining / leg)
			const [aLon, aLat] = polyline[i]!
			const [bLon, bLat] = polyline[i + 1]!

			return [aLon + (bLon - aLon) * f, aLat + (bLat - aLat) * f, total]
		}
		remaining -= leg
	}
	const [lon, lat] = polyline.at(-1)!

	return [lon, lat, total]
}
