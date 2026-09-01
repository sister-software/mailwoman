/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CAPITAL-STATUS reference index (#1880) — answers, for one resolved candidate, "is this
 *   place the national capital or an admin-1 seat of its country?". The consumer is the resolver's
 *   bounded capital promotion (`@mailwoman/resolver`'s `promoteCapitals`, applied after the fame
 *   key on the bare-toponym class); this module only matches, it never ranks. PURE and
 *   platform-free (the #861 parity discipline).
 *
 *   Matching is an IDENTITY test with three conjuncts: same country, within
 *   {@link CAPITAL_MATCH_RADIUS_KM} of the reference point, and the candidate's own folded name a
 *   member of the reference entry's folded name set (name + romanization + the source's alternate
 *   names, so exonym rows — "Vienna" for Wien — still match). All three are required. The
 *   iteration-1 board run matched on country + coordinate alone, and the 25 km radius promoted
 *   capital-ADJACENT namesakes instead of capitals: North Salt Lake beside the Utah seat, a Gujarat
 *   Indiranagar beside Gandhinagar, Via delle Parti beside Perugia. The name set is what makes the
 *   radius a centroid-drift allowance rather than a catchment.
 */

import { haversineKm } from "@mailwoman/spatial"

import { normalizeLocalityForKey } from "#street/normalize"

/**
 * Capital status of one candidate: national capital, admin-1 seat, or neither. Numeric so the resolver's promotion can
 * compare levels.
 */
export const CAPITAL_LEVEL = {
	none: 0,
	admin1: 1,
	national: 2,
} as const

export type CapitalLevel = (typeof CAPITAL_LEVEL)[keyof typeof CAPITAL_LEVEL]

/**
 * How far a candidate row may sit from the reference point and still read as the same place — a centroid-convention
 * allowance (GeoNames point vs WOF centroid on a metro-scale city), not a catchment: the name-membership conjunct is
 * what excludes neighbours inside the radius.
 */
export const CAPITAL_MATCH_RADIUS_KM = 25

/**
 * One reference entry, as `data/gazetteer/capitals-v1.json` carries it (`entries[]`).
 */
export interface CapitalPoint {
	/**
	 * ISO alpha-2, uppercase.
	 */
	country: string
	latitude: number
	longitude: number
	level: "national" | "admin1"
	/**
	 * Folded name keys (name + romanization + alternate names, `normalizeLocalityForKey` fold) — the membership set for
	 * the name conjunct.
	 */
	k: string[]
}

const LEVEL_OF: Record<CapitalPoint["level"], CapitalLevel> = {
	national: CAPITAL_LEVEL.national,
	admin1: CAPITAL_LEVEL.admin1,
}

interface IndexedPoint {
	latitude: number
	longitude: number
	level: CapitalLevel
	keys: ReadonlySet<string>
}

/**
 * Country-bucketed capital points with the three-conjunct identity probe. Construct from the parsed reference file's
 * `entries` — the loader that reads the file off disk lives with the path owners (`mailwoman`'s resolver backend),
 * keeping this module platform-free.
 */
export class CapitalIndex {
	readonly #byCountry = new Map<string, IndexedPoint[]>()

	constructor(entries: Iterable<CapitalPoint>) {
		for (const entry of entries) {
			const country = entry.country.toUpperCase()

			const point: IndexedPoint = {
				latitude: entry.latitude,
				longitude: entry.longitude,
				level: LEVEL_OF[entry.level],
				keys: new Set(entry.k),
			}

			const bucket = this.#byCountry.get(country)

			if (bucket) {
				bucket.push(point)
			} else {
				this.#byCountry.set(country, [point])
			}
		}
	}

	/**
	 * The highest capital level whose entry passes all three conjuncts for this place. `none` — never a throw — for a
	 * missing name, country, or coordinate, an unknown country, or no matching entry.
	 */
	levelOfPlace(
		name: string | null | undefined,
		country: string | null | undefined,
		latitude: number | null | undefined,
		longitude: number | null | undefined
	): CapitalLevel {
		if (!name || !country || typeof latitude !== "number" || typeof longitude !== "number") return CAPITAL_LEVEL.none

		const bucket = this.#byCountry.get(country.toUpperCase())

		if (!bucket) return CAPITAL_LEVEL.none

		const key = String(normalizeLocalityForKey(name))

		if (!key) return CAPITAL_LEVEL.none

		let best: CapitalLevel = CAPITAL_LEVEL.none

		for (const point of bucket) {
			if (
				point.level > best &&
				point.keys.has(key) &&
				haversineKm(latitude, longitude, point.latitude, point.longitude) <= CAPITAL_MATCH_RADIUS_KM
			) {
				best = point.level
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
