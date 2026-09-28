/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   How specific a placetype is, the ordering `Placetype.ts` deliberately does not give you.
 *
 *   WOF placetype ids follow assignment order, and `Placetype.ts` says so in place. Consumers that
 *   need to compare placetypes rank them here instead.
 *
 *   This scale orders the eleven placetypes it shares with `resolver-wof-sqlite/ancestry.ts`'s
 *   `PLACETYPE_DEPTH` identically, and `specificity.test.ts` holds that agreement. The two scales
 *   differ in offset and in what an unranked placetype means, never in which of two placetypes is
 *   finer.
 */

import type { WhosOnFirstPlacetype } from "#resources/whosonfirst/placetypes/definition"

/**
 * Higher is finer.
 *
 * Absent placetypes are unranked and must be handled by the caller rather than defaulted.
 * A missing entry silently scoring 0 would rank an unknown placetype as coarse as `country`,
 * which is the wrong direction for every check that reads this.
 */
export const PLACETYPE_SPECIFICITY: Readonly<Partial<Record<WhosOnFirstPlacetype | (string & {}), number>>> = {
	address: 11,
	building: 10,
	campus: 10,
	venue: 10,
	postalcode: 9,
	microhood: 8,
	neighbourhood: 7,
	macrohood: 6,
	borough: 5,
	locality: 4,
	localadmin: 3,
	county: 2,
	macrocounty: 1,
	region: 0,
	macroregion: -1,
	country: -2,
	dependency: -2,
	continent: -3,
	empire: -4,
	planet: -5,
}

/**
 * The rank of a placetype, or `undefined` when it carries none.
 *
 * Returning `undefined` rather than a number is the point: a caller that cannot rank
 * a row has to decide what that means for its own check, and the two reasonable
 * answers (block conservatively, or ignore) differ per call site.
 */
export function placetypeSpecificity(placetype: string | null | undefined): number | undefined {
	if (!placetype) return undefined

	return PLACETYPE_SPECIFICITY[placetype]
}

/**
 * Is `candidate` at least as fine-grained as `reference`?
 *
 * `undefined` when either placetype is unranked, leaving the caller to decide.
 * The comparison is `>=` so an equal rung counts as covering, which is what a check for whether
 * the place is already represented wants.
 */
export function isAtLeastAsSpecific(
	candidate: string | null | undefined,
	reference: string | null | undefined
): boolean | undefined {
	const a = placetypeSpecificity(candidate)
	const b = placetypeSpecificity(reference)

	if (a === undefined || b === undefined) return undefined

	return a >= b
}

/**
 * Is `candidate` strictly finer than `reference`, a child rung rather than the same one?
 *
 * The distinction from {@link isAtLeastAsSpecific} matters for the equal case. A check for whether
 * a live row covers a dead one wants an equal rung to count as covering, so a live `locality`
 * covers a dead `locality` of the same name.
 *
 * Negating `isAtLeastAsSpecific(live, dead)` answers whether the live row is strictly coarser and
 * quietly drops the equal case.
 *
 * `undefined` when either placetype is unranked. A caller filtering on this should treat that as
 * not strictly finer.
 */
export function isStrictlyFiner(
	candidate: string | null | undefined,
	reference: string | null | undefined
): boolean | undefined {
	const a = placetypeSpecificity(candidate)
	const b = placetypeSpecificity(reference)

	if (a === undefined || b === undefined) return undefined

	return a > b
}
