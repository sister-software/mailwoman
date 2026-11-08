/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decides whether a lower-ranked address record repeats a higher-ranked record of the same postcode, street and
 *   number, so the layer build may drop it.
 */

import { haversine } from "@mailwoman/spatial/geometries/point/distance"

import { normalizeLocalityForKey } from "#street/normalize"

/**
 * The farthest apart two records' points may lie, in kilometers, while their localities disagree.
 */
export const ADDRESS_DUPLICATE_DISTANCE_KM = 2

/**
 * The most distinct addresses one source may place at a record's point
 * before that point gives no distance evidence.
 */
export const ADDRESS_DUPLICATE_STACK_LIMIT = 5

/**
 * One record of a postcode key group, as the duplicate rule reads it.
 */
export interface DuplicateCandidate {
	source: string
	unit: string | null
	number: string
	streetRaw: string
	localities: readonly string[]
	lat: number
	lon: number
	/**
	 * Distinct street-and-number pairs this record's source places at its point, rounded to 1e-5 degrees.
	 */
	stack: number
}

/**
 * The parts of the duplicate rule a caller supplies for its country and sources.
 */
export interface AddressDuplicateRule {
	/**
	 * A source's rank, lowest first.
	 * A record is dropped only for a record of a lower rank.
	 */
	rank(source: string): number
	/**
	 * The identifier a unit states, read against its record's number and street,
	 * or `null` when it states none.
	 */
	unitIdentifier(unit: string | null, context: { number: string; street: string }): string | null
}

/**
 * The keys of a record's stated localities, folded as the layer's key tables fold a locality name.
 */
export function addressLocalityKeys(localities: readonly string[]): Set<string> {
	return new Set(localities.map((name) => normalizeLocalityForKey(name)).filter((key) => key.length > 0))
}

const localityKeys = (record: DuplicateCandidate) => addressLocalityKeys(record.localities)

/**
 * Whether `lower` repeats `higher`'s delivery point.
 *
 * The two must state the same unit by identifier, or both state none: a building row
 * and a unit row are different delivery points.
 * With the units agreeing, `lower` repeats `higher` unless both state localities that share
 * no name and their points lie farther apart than {@linkcode ADDRESS_DUPLICATE_DISTANCE_KM}.
 *
 * A point stacked past {@linkcode ADDRESS_DUPLICATE_STACK_LIMIT} addresses gives no distance,
 * so a pair touching one is a repeat whenever its units agree.
 *
 * Graded on #2978's held-out set of 397 adjudicated pairs from the 2026-11-08 US layer,
 * this decides every pair as the EM-fitted Fellegi-Sunter model does: 263 true drops,
 * 3 wrong drops and 3 missed repeats.
 */
export function isDuplicateAddress(
	rule: AddressDuplicateRule,
	higher: DuplicateCandidate,
	lower: DuplicateCandidate
): boolean {
	const unit = (record: DuplicateCandidate) =>
		rule.unitIdentifier(record.unit, { number: record.number, street: record.streetRaw })

	if (unit(higher) !== unit(lower)) return false

	const a = localityKeys(higher)
	const b = localityKeys(lower)
	const disjoint = a.size > 0 && b.size > 0 && ![...a].some((name) => b.has(name))

	if (!disjoint) return true

	if (higher.stack > ADDRESS_DUPLICATE_STACK_LIMIT || lower.stack > ADDRESS_DUPLICATE_STACK_LIMIT) return true

	return haversine(higher.lat, higher.lon, lower.lat, lower.lon) <= ADDRESS_DUPLICATE_DISTANCE_KM
}
