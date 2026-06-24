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

import { haversineKm as greatCircleKm } from "@mailwoman/spatial"
import type { LatLon } from "./blocking.js"
import type { Comparison, ComparisonLevel } from "./fellegi-sunter.js"

/**
 * Great-circle (haversine) distance in km between two coordinates. The formula's one true home is
 * `@mailwoman/spatial`; this is a thin domain-typed adapter from `match`'s `LatLon` ({ latitude,
 * longitude }) onto the canonical scalar helper — not a second implementation.
 */
export const haversineKm = (a: LatLon, b: LatLon): number =>
	greatCircleKm(a.latitude, a.longitude, b.latitude, b.longitude)

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

/**
 * The collapsed spatial-agreement comparison — ONE non-redundant geographic signal.
 *
 * The first matcher carried TWO spatial comparisons: canonical-address-key similarity AND
 * great-circle distance. They double-count — an exact key match implies distance ≈ 0, so a
 * co-located pair banked the same evidence twice, and the redundant vote is exactly what
 * over-merges distinct providers at a shared clinic address. This folds them into one comparison:
 *
 * - **level 0 `same-key`** — an EXACT canonical-key match: the strongest tier, and the one the
 *   inverse-address-frequency adjustment rides ({@link withTermFrequency} on level 0), so agreement
 *   on a crowded shared key is down-weighted toward worthless while a rare one keeps full weight.
 * - **levels 1…n** — great-circle distance buckets for pairs whose keys DIFFER, so "123 Main St" vs
 *   "123 Main Street Apt 2" that geocode to the same rooftop still earns near-agreement (the
 *   geo-first point of the whole design).
 * - Keys differ and no usable coordinate → no evidence.
 *
 * Exactly one spatial vote, no redundancy. Pass {@link DEFAULT_SPATIAL_LEVELS} or your own; index 0
 * must be the exact-key tier, indices 1…n the distance buckets nearest → far by `maxKm` (last =
 * `far`).
 */
export function spatialComparison<R>(config: {
	name: string
	key: (record: R) => string | null | undefined
	coordinate: (record: R) => LatLon | null | undefined
	levels: ComparisonLevel[]
}): Comparison<R> {
	const valid = (c: LatLon | null | undefined): c is LatLon =>
		!!c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)

	return {
		name: config.name,
		levels: config.levels,
		assess(a, b) {
			const ka = config.key(a)
			const kb = config.key(b)
			if (ka && kb && ka.trim() && ka === kb) return 0 // exact canonical-key match — one strong vote

			const ca = config.coordinate(a)
			const cb = config.coordinate(b)
			if (!valid(ca) || !valid(cb)) return -1 // keys differ and no coordinate → no spatial evidence

			const km = haversineKm(ca, cb)
			for (let i = 1; i < config.levels.length; i++) {
				if (km <= (config.levels[i]!.maxKm ?? Infinity)) return i
			}
			return config.levels.length - 1
		},
	}
}

/**
 * Default levels for {@link spatialComparison}: an exact same-key tier on top of the distance
 * buckets. `m`/`u` are EM-estimable seeds (m decreasing, u increasing down the tiers; each column ≈
 * sums to 1).
 */
export const DEFAULT_SPATIAL_LEVELS: ComparisonLevel[] = [
	{ label: "same-key", m: 0.85, u: 0.01 },
	{ label: "same-building", maxKm: 0.05, m: 0.1, u: 0.02 },
	{ label: "same-block", maxKm: 0.5, m: 0.03, u: 0.05 },
	{ label: "same-area", maxKm: 5, m: 0.015, u: 0.2 },
	{ label: "far", m: 0.005, u: 0.72 },
]
