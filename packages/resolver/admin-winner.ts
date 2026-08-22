/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Which resolved admin place answers the query — the one ordering whose postcode rung is not a constant.
 *
 *   `postalcode` is the only placetype whose specificity depends on the hit rather than the name. An NL PC6 or a GB unit
 *   postcode covers ~8 and ~15 addresses, categorically tighter than any locality centroid; a US ZIP, a French code
 *   postal or a German PLZ covers a delivery AREA. `PLACETYPE_SPECIFICITY` answers "which placetype covers less ground"
 *   and cannot express that split, so a consumer that sorts by it alone promotes every postcode.
 *
 *   Two consumers need the split in two shapes, and both live here so a divergence is a test failure rather than a
 *   silent disagreement: result assembly walks a TAG ladder, and the eval harnesses sort resolved nodes by placetype.
 */

import { isUnitGradePostcodeHit } from "@mailwoman/codex"
import { PLACETYPE_SPECIFICITY } from "@mailwoman/core/resources/whosonfirst/specificity"

/**
 * The admin fallback order when the resolved postcode is a unit-grade exact hit — the postcode leads.
 */
export const ADMIN_LADDER_UNIT_POSTCODE: ReadonlyArray<string> = [
	"postcode",
	"locality",
	"dependent_locality",
	"region",
	"country",
]

/**
 * The admin fallback order everywhere else: the locality tiers lead and the postcode sits between them and `region`.
 *
 * This arm is a PER-ADDRESS-SYSTEM claim held as a global default, and two tier-1 locales are on the wrong side of it.
 * Coordinate p50 on 400 OpenAddresses rows per country, THIS arm vs the postcode point: DE 5.73 km / 1.21, US 3.58 /
 * 2.49, FR 1.07 / 2.57, IT 1.43 / 3.16, ES 0.66 / 0.98. FR, IT and ES want the locality; DE and US want the postcode,
 * and code length does not predict which — FR and DE are both 5-digit and disagree.
 *
 * Moving this list changes runtime answers, so it needs a declared epoch and a before/after, not a cleanup pass. #1780.
 */
export const ADMIN_LADDER_LOCALITY_FIRST: ReadonlyArray<string> = [
	"locality",
	"dependent_locality",
	"postcode",
	"region",
	"country",
]

/**
 * The resolved postcode a ladder decision reads: the PARSED span and the resolver's own hit. Both are needed — a full
 * unit shape the resolver answered with a coarser stem is area-grade, whatever the user typed.
 */
export interface ResolvedPostcodeHit {
	value: string
	resolverName: string | undefined
}

/**
 * Pick the admin fallback order for one resolved tree.
 */
export function adminLadderFor(postcode: ResolvedPostcodeHit | undefined): ReadonlyArray<string> {
	return postcode !== undefined && isUnitGradePostcodeHit(postcode.value, postcode.resolverName)
		? ADMIN_LADDER_UNIT_POSTCODE
		: ADMIN_LADDER_LOCALITY_FIRST
}

/**
 * Where an AREA-grade postal code sits on `PLACETYPE_SPECIFICITY`: below the whole locality tier, above `county` (2).
 *
 * The tier is `PLACETYPE_FILTER_GROUPS.locality` — `locality` (4), `borough` (5) and `localadmin` (3) — not the
 * `locality` placetype alone, because that is what the resolver's own `locality` tag expands to. New England civil
 * towns are `localadmin` in WOF, so a value between `locality` and `localadmin` would rank a US ZIP above the town it
 * sits in and reproduce the defect on exactly the rows that motivated the group.
 *
 * Deliberately not an integer. The scale's rungs are placetypes and this is not one — it is the position
 * {@link ADMIN_LADDER_LOCALITY_FIRST} puts a postcode in, expressed on the scale the sorting consumers already use.
 */
export const AREA_GRADE_POSTALCODE_SPECIFICITY = 2.5

/**
 * A resolved place, as much of it as an ordering decision reads.
 */
export interface ResolvedSpecificityInput {
	placetype: string
	/**
	 * The parsed span. Absent for a non-postcode candidate, where nothing conditional applies.
	 */
	value?: string
	/**
	 * The resolver's own hit name, as `resolver_name` metadata carries it.
	 */
	resolverName?: string
}

/**
 * Rank a resolved place for "whose coordinate answers the query" — `PLACETYPE_SPECIFICITY`, except that a `postalcode`
 * is ranked by its hit.
 *
 * An unranked placetype returns `-Infinity` so it wins only when nothing else resolved.
 */
export function resolvedSpecificity(candidate: ResolvedSpecificityInput): number {
	if (candidate.placetype !== "postalcode") {
		return PLACETYPE_SPECIFICITY[candidate.placetype] ?? Number.NEGATIVE_INFINITY
	}

	return isUnitGradePostcodeHit(candidate.value ?? "", candidate.resolverName)
		? (PLACETYPE_SPECIFICITY["postalcode"] ?? Number.NEGATIVE_INFINITY)
		: AREA_GRADE_POSTALCODE_SPECIFICITY
}

/**
 * The best of a resolved set under {@link resolvedSpecificity}, or `null` when the set is empty. Ties keep the first,
 * which is document order.
 *
 * `toInput` is explicit rather than structural because each consumer spells the resolver's hit differently — the eval
 * harnesses carry it as `name`, result assembly reads it off `resolver_name` metadata — and a projection at the call
 * site is where that mapping is visible.
 */
export function mostSpecificResolved<T>(
	candidates: readonly T[],
	toInput: (candidate: T) => ResolvedSpecificityInput
): T | null {
	let best: T | null = null
	let bestRank = Number.NEGATIVE_INFINITY

	for (const candidate of candidates) {
		const rank = resolvedSpecificity(toInput(candidate))

		if (best === null || rank > bestRank) {
			best = candidate
			bestRank = rank
		}
	}

	return best
}
