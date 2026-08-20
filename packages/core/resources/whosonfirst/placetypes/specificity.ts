/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   How SPECIFIC a placetype is — the ordering `Placetype.ts` deliberately does not give you.
 *
 *   WOF placetype ids are assignment order, and `Placetype.ts` says so in place ("these IDs are not in any specific
 *   order. Avoid using them for sorting."). Every consumer that needs "is this row finer or coarser than that one"
 *   therefore writes its own table, and two identical copies already existed — `eval-harness/oa-resolver-eval.ts` and
 *   `dev-tools/score-hard-slice-board.run.ts` — agreeing on seven placetypes and both missing everything below
 *   `localadmin`.
 *
 *   THAT SHARED GAP IS WHY THIS FILE EXISTS. #1746: the currency backfill refused to
 *   resurrect a deprecated locality whenever ANY live same-name row sat within 10 km, "possibly under another
 *   placetype". For a place recorded twice that premise holds. For a placetype DEMOTION it does not — WOF retired
 *   `Gillingham` the locality (pop 101,187) and kept `Gillingham` the neighbourhood 3.2 km away, and the gate read the
 *   surviving CHILD as covering its own dead parent. Sixteen of seventeen GB refusals had exactly that shape. A rank
 *   comparison separates the two cases, and it needs the fine end of the scale that neither existing copy carried.
 *
 *   Ties are meaningful and not sloppiness: `localadmin` and `borough` occupy the same rung because WOF uses them for
 *   the same tier in different countries, and a tie makes each block the other — the conservative direction for a gate
 *   whose failure mode is inventing a place.
 *
 *   IT IS NOT THE ONLY TABLE, and a reader comparing it to a neighbour will find disagreements rather than a copy.
 *   `resolver-wof-sqlite/ancestry.ts` publishes `PLACETYPE_DEPTH` for hierarchical containment (unknown maps to 0 and
 *   sorts coarsest), and `eval-harness/gauntlet/ablation-expectation.ts` carries a deliberate copy of THAT one so an
 *   old artifact can be re-graded against the table it was built with. Over the eleven placetypes all three share,
 *   this scale and `PLACETYPE_DEPTH` order three pairs differently:
 *
 *   - `macrocounty` / `county` — DEPTH separates them, this ties them
 *   - `localadmin` / `borough` — DEPTH puts `borough` finer, this ties them
 *   - `locality` / `borough` — DEPTH puts `borough` FINER, this puts it coarser
 *
 *   The first two are the tie described above. The third is an inversion and is under review: a NYC borough sits
 *   inside its locality, which is DEPTH's reading, and the direction of that pair changes which dead rows the
 *   currency gate frees. 2,519 borough rows carry it against 8.2M localities.
 */

import type { WhosOnFirstPlacetype } from "./definition.ts"

/**
 * Higher is finer. Absent placetypes are UNRANKED and must be handled by the caller rather than defaulted — a missing
 * entry silently scoring 0 would rank an unknown placetype as coarse as `country`, which is the wrong direction for
 * every gate that reads this.
 */
export const PLACETYPE_SPECIFICITY: Readonly<Partial<Record<WhosOnFirstPlacetype | (string & {}), number>>> = {
	address: 9,
	building: 8,
	campus: 8,
	venue: 8,
	postalcode: 7,
	microhood: 6,
	neighbourhood: 5,
	macrohood: 4,
	locality: 3,
	localadmin: 2,
	borough: 2,
	county: 1,
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
 * Returning `undefined` rather than a number is the point: a caller that cannot rank a row has to decide what that
 * means for its own gate, and the two reasonable answers (block conservatively, or ignore) differ per call site.
 */
export function placetypeSpecificity(placetype: string | null | undefined): number | undefined {
	if (!placetype) return undefined

	return PLACETYPE_SPECIFICITY[placetype]
}

/**
 * Is `candidate` at least as fine-grained as `reference`?
 *
 * `undefined` when either placetype is unranked — the caller decides. The comparison is `>=` so an equal rung counts as
 * covering, which is what a "this place is already represented" check wants.
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
 * Is `candidate` STRICTLY finer than `reference` — a child rung, not the same one?
 *
 * The distinction from {@link isAtLeastAsSpecific} is the whole bug it was written for. "Does this live row cover that
 * dead one" wants the EQUAL case to count as covering: a live `locality` plainly covers a dead `locality` of the same
 * name. Asking `isAtLeastAsSpecific(live, dead)` and negating it answers "is the live row strictly coarser", which
 * quietly drops the equal case — measured on the real artifact, that turned 973 blocked rows into 18 and would have
 * resurrected 955 places that are already alive.
 *
 * `undefined` when either placetype is unranked; a caller gating on this should treat that as "not strictly finer".
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
