/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Geographic distance as a scoring feature — the other half of geocode-first matching.
 *
 *   Blocking uses geography to _propose_ candidates; this scores them on it. The research is explicit
 *   that an address must be matched as a SPATIAL attribute, not by string similarity (a
 *   one-character edit can be 650 m apart), and that distance measurably helps as a comparison
 *   feature. So we bucket the great-circle distance between two records' coordinates into ordered
 *   Fellegi-Sunter agreement levels (Splink's `DistanceInKMAtThresholds`): "same building" / "same
 *   block" / "same area" / far, each with its own m/u and weight.
 *
 *   Calibrate the bucket boundaries to the geocoder's OWN error, which is heavy-tailed and density-
 *   dependent (≈38 m urban, ≈200 m rural). A weakening of this evidence by geocode quality (a
 *   shared interpolated centroid is softer than a shared rooftop point) is the documented
 *   refinement.
 */

import type { LatLon } from "./blocking.js"
import type { Comparison, ComparisonLevel } from "./fellegi-sunter.js"

/** Mean Earth radius in km (IUGG). */
const EARTH_RADIUS_KM = 6371.0088

/** Great-circle (haversine) distance in km between two coordinates. */
export function haversineKm(a: LatLon, b: LatLon): number {
	const toRad = (degrees: number): number => (degrees * Math.PI) / 180
	const dLat = toRad(b.latitude - a.latitude)
	const dLon = toRad(b.longitude - a.longitude)
	const lat1 = toRad(a.latitude)
	const lat2 = toRad(b.latitude)

	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * A geo-distance comparison: bucket the great-circle distance between two records' coordinates into
 * ordered agreement levels. Levels must be ordered NEAREST first by `maxKm`, the last acting as the
 * `far` catch-all (`maxKm` omitted → unbounded). A missing/invalid coordinate on either side yields
 * no evidence.
 */
export function distanceComparison<R>(config: {
	name: string
	extract: (record: R) => LatLon | null | undefined
	levels: ComparisonLevel[]
}): Comparison<R> {
	const valid = (c: LatLon | null | undefined): c is LatLon =>
		!!c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)

	return {
		name: config.name,
		levels: config.levels,
		assess(a, b) {
			const ca = config.extract(a)
			const cb = config.extract(b)
			if (!valid(ca) || !valid(cb)) return -1

			const km = haversineKm(ca, cb)
			for (let i = 0; i < config.levels.length; i++) {
				if (km <= (config.levels[i]!.maxKm ?? Infinity)) return i
			}
			return config.levels.length - 1
		},
	}
}

/**
 * Default distance levels, nearest → far, with boundaries at rooftop / block / locality scale. The
 * m/u are illustrative seeds (EM re-estimates them); the boundaries reflect typical geocoder
 * error.
 */
export const DEFAULT_DISTANCE_LEVELS: ComparisonLevel[] = [
	{ label: "same-building", maxKm: 0.05, m: 0.7, u: 0.001 },
	{ label: "same-block", maxKm: 0.5, m: 0.2, u: 0.02 },
	{ label: "same-area", maxKm: 5, m: 0.08, u: 0.2 },
	{ label: "far", m: 0.02, u: 0.779 },
]
