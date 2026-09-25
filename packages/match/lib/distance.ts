/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { haversineKm as greatCircleKm } from "@mailwoman/spatial"

import type { LatLon } from "#blocking"
import type { Comparison, ComparisonLevel } from "#fellegi-sunter"

/**
 * Computes the great-circle distance in kilometres between two `LatLon` records by
 * delegating to the scalar helper in `@mailwoman/spatial`.
 */
export const haversineKm = (a: LatLon, b: LatLon): number =>
	greatCircleKm(a.latitude, a.longitude, b.latitude, b.longitude)

/**
 * Creates a comparison that buckets the great-circle distance between two records into
 * levels ordered nearest first by `maxKm`, with the last level catching everything farther.
 *
 * A missing or non-finite coordinate on either side yields no evidence.
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
 * Provides default distance levels at building, block and area scale, whose `m`
 * and `u` values are seeds for EM re-estimation.
 */
export const DEFAULT_DISTANCE_LEVELS: ComparisonLevel[] = [
	{ label: "same-building", maxKm: 0.05, m: 0.7, u: 0.001 },
	{ label: "same-block", maxKm: 0.5, m: 0.2, u: 0.02 },
	{ label: "same-area", maxKm: 5, m: 0.08, u: 0.2 },
	{ label: "far", m: 0.02, u: 0.779 },
]

/**
 * Creates a single spatial comparison whose level 0 is an exact canonical-key match
 * and whose remaining levels bucket great-circle distance for pairs with different keys.
 *
 * It replaces separate key and distance comparisons, which count a co-located pair's
 * evidence twice and over-merge distinct entities at a shared address.
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

			if (ka && kb && ka.trim() && ka === kb) return 0

			const ca = config.coordinate(a)
			const cb = config.coordinate(b)

			if (!valid(ca) || !valid(cb)) return -1

			const km = haversineKm(ca, cb)

			for (let i = 1; i < config.levels.length; i++) {
				if (km <= (config.levels[i]!.maxKm ?? Infinity)) return i
			}

			return config.levels.length - 1
		},
	}
}

/**
 * Provides default levels for {@link spatialComparison}: an exact same-key tier followed
 * by the building, block, area and far distance buckets, with seed `m` and `u` values.
 */
export const DEFAULT_SPATIAL_LEVELS: ComparisonLevel[] = [
	{ label: "same-key", m: 0.85, u: 0.01 },
	{ label: "same-building", maxKm: 0.05, m: 0.1, u: 0.02 },
	{ label: "same-block", maxKm: 0.5, m: 0.03, u: 0.05 },
	{ label: "same-area", maxKm: 5, m: 0.015, u: 0.2 },
	{ label: "far", m: 0.005, u: 0.72 },
]
