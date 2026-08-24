/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CAPITAL-STATUS ranking axis (#1880) — a bounded preference for the national capital or
 *   admin-1 seat among same-name candidates, consumed by `rankByPrimaryPreference` on unscoped
 *   bare-name lookups. PURE and platform-free (the #861 parity discipline): the Node candidate
 *   lookup and any browser twin must rank with the SAME function.
 *
 *   Matching is by COUNTRY + COORDINATE, never by name. The candidate row already matched the
 *   queried surface — via primary name, alias, or exonym — so the open question is identity: "is
 *   this row the capital of its country?" A coordinate answers that in every language, and cannot
 *   fall out of date the way an exonym list can. The radius absorbs centroid-convention drift
 *   between the reference's point (GeoNames) and the candidate's (WOF).
 *
 *   The preference is BOUNDED in log10-population units, like the cross-country primary preference
 *   this file's consumer applies: a capital outranks a more-populous namesake only within the
 *   margin, so "San José" reaches the Costa Rican capital over San Jose CA (gap 0.45 < 2) while
 *   "Hamilton" stays on Hamilton ON over Bermuda's 900-person capital (gap 2.76 > 2). A row with
 *   no recorded population never receives the bonus — population 0 means NO EVIDENCE, and a bonus
 *   on a no-evidence row would promote whichever duplicate happens to sit at the capital's
 *   coordinates.
 */

import { haversineKm } from "@mailwoman/spatial"

/**
 * Capital status of one candidate row: national capital, admin-1 seat, or neither. Numeric so the ranking arithmetic
 * can scale the bonus by level.
 */
export const CAPITAL_LEVEL = {
	none: 0,
	admin1: 1,
	national: 2,
} as const

export type CapitalLevel = (typeof CAPITAL_LEVEL)[keyof typeof CAPITAL_LEVEL]

/**
 * How far a candidate row may sit from the reference point and still read as the same place. Covers the GeoNames-vs-WOF
 * centroid gap on a metro-scale city; small enough that a same-name town elsewhere in the country never matches.
 */
export const CAPITAL_MATCH_RADIUS_KM = 25

/**
 * The national-capital preference margin, in log10-population units: a non-capital namesake must be more than 10^2 =
 * 100× more populous than the capital to outrank it.
 */
export const NATIONAL_CAPITAL_PREFERENCE_LOG10 = 2

/**
 * The admin-1-seat margin: 10× — a state capital holds its name against a same-name peer up to an order of magnitude
 * larger (Springfield IL over Springfield MO), and yields beyond it.
 */
export const ADMIN_SEAT_PREFERENCE_LOG10 = 1

/**
 * The bonus (in log10-population units, SUBTRACTED from `neg_rank`) for a given level.
 */
export function capitalPreferenceLog10(level: CapitalLevel): number {
	if (level === CAPITAL_LEVEL.national) return NATIONAL_CAPITAL_PREFERENCE_LOG10

	return level === CAPITAL_LEVEL.admin1 ? ADMIN_SEAT_PREFERENCE_LOG10 : 0
}

/**
 * One reference point, as `data/gazetteer/capitals-v1.json` carries it (`entries[]`).
 */
export interface CapitalPoint {
	/**
	 * ISO alpha-2, uppercase.
	 */
	country: string
	latitude: number
	longitude: number
	level: "national" | "admin1"
}

const LEVEL_OF: Record<CapitalPoint["level"], CapitalLevel> = {
	national: CAPITAL_LEVEL.national,
	admin1: CAPITAL_LEVEL.admin1,
}

/**
 * Country-bucketed capital points with a proximity probe. Construct from the parsed reference file's `entries` — the
 * loader that reads the file off disk lives with the path owners (`mailwoman`'s resolver backend), keeping this module
 * platform-free.
 */
export class CapitalIndex {
	readonly #byCountry = new Map<string, CapitalPoint[]>()

	constructor(entries: Iterable<CapitalPoint>) {
		for (const entry of entries) {
			const country = entry.country.toUpperCase()
			const bucket = this.#byCountry.get(country)

			if (bucket) {
				bucket.push(entry)
			} else {
				this.#byCountry.set(country, [entry])
			}
		}
	}

	/**
	 * The highest capital level within {@link CAPITAL_MATCH_RADIUS_KM} of the point, among the given country's reference
	 * entries. `none` for an unknown country, a missing coordinate, or no nearby entry.
	 */
	levelAt(
		country: string | undefined,
		latitude: number | null | undefined,
		longitude: number | null | undefined
	): CapitalLevel {
		if (!country || typeof latitude !== "number" || typeof longitude !== "number") return CAPITAL_LEVEL.none

		const bucket = this.#byCountry.get(country.toUpperCase())

		if (!bucket) return CAPITAL_LEVEL.none

		let best: CapitalLevel = CAPITAL_LEVEL.none

		for (const point of bucket) {
			const level = LEVEL_OF[point.level]

			if (
				level > best &&
				haversineKm(latitude, longitude, point.latitude, point.longitude) <= CAPITAL_MATCH_RADIUS_KM
			) {
				best = level
			}
		}

		return best
	}

	get size(): number {
		let n = 0

		for (const bucket of this.#byCountry.values()) {
			n += bucket.length
		}

		return n
	}
}
