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

import { areaPostcodeLeadsLocality, isUnitGradePostcodeHit } from "@mailwoman/codex"
import type { AddressNode } from "@mailwoman/core/decoder"
import { PLACETYPE_SPECIFICITY } from "@mailwoman/core/resources/whosonfirst/specificity"

/**
 * The admin fallback order when the postcode leads — a unit-grade exact hit, or an address system whose area-grade code
 * is still finer than its locality ({@link areaPostcodeLeadsLocality}).
 */
export const ADMIN_LADDER_POSTCODE_FIRST: ReadonlyArray<string> = [
	"postcode",
	"locality",
	"dependent_locality",
	"region",
	"country",
]

/**
 * The admin fallback order everywhere else: the locality tiers lead and the postcode sits between them and `region`.
 *
 * This is the #945 epoch convention, and it is the DEFAULT rather than the universal answer — which address systems
 * leave it is `AREA_POSTCODE_FINER_THAN_LOCALITY`'s question, and that table carries the per-country measurement.
 */
export const ADMIN_LADDER_LOCALITY_FIRST: ReadonlyArray<string> = [
	"locality",
	"dependent_locality",
	"postcode",
	"region",
	"country",
]

/**
 * The resolved postcode a ladder decision reads: the PARSED span, the resolver's own hit, and the country the resolver
 * placed it in.
 *
 * The first two are needed together because a full unit shape the resolver answered with a coarser stem is area-grade,
 * whatever the user typed. `country` is separate evidence and answers a different question — not how tight this code
 * is, but whether this address system's codes are tighter than its localities at all.
 */
export interface ResolvedPostcodeHit {
	value: string
	resolverName: string | undefined
	/**
	 * ISO-3166 alpha-2 the RESOLVER placed the postcode in, not a caller's requested scope. Absent when the postcode did
	 * not resolve to a country, which reads as the locality-first default.
	 */
	country?: string
}

/**
 * Pick the admin fallback order for one resolved tree.
 *
 * Two independent routes to postcode-first: the code itself is unit-grade, or the address system's area-grade codes are
 * finer than its localities. Either one is sufficient and the second is what makes this per-country rather than
 * global.
 */
export function adminLadderFor(postcode: ResolvedPostcodeHit | undefined): ReadonlyArray<string> {
	if (postcode === undefined) return ADMIN_LADDER_LOCALITY_FIRST

	const leads =
		isUnitGradePostcodeHit(postcode.value, postcode.resolverName) || areaPostcodeLeadsLocality(postcode.country)

	return leads ? ADMIN_LADDER_POSTCODE_FIRST : ADMIN_LADDER_LOCALITY_FIRST
}

/**
 * The ladder for a flat list of resolved nodes — the shape result assembly holds.
 *
 * Which node counts, and which of its fields the decision reads, is part of the ordering rather than the caller's
 * business: `country` is the one the RESOLVER placed the code in, never a caller's requested scope, because the ladder
 * is asking which address system this code belongs to and a scope is a filter on the answer rather than evidence about
 * it. Getting that wrong at a call site would be invisible.
 */
export function adminLadderForNodes(nodes: readonly AddressNode[]): ReadonlyArray<string> {
	const node = nodes.find((n) => n.tag === "postcode" && n.lat != null && n.lon != null)

	if (!node) return ADMIN_LADDER_LOCALITY_FIRST

	const country = node.metadata?.["resolver_country"]

	return adminLadderFor({
		value: node.value,
		resolverName: node.metadata?.["resolver_name"] as string | undefined,
		...(typeof country === "string" ? { country } : {}),
	})
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
	 * ISO-3166 alpha-2 the resolver placed this candidate in. Read only for a `postalcode`, where it decides whether the
	 * address system's area-grade codes outrank its localities.
	 */
	country?: string
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

	const leads =
		isUnitGradePostcodeHit(candidate.value ?? "", candidate.resolverName) ||
		areaPostcodeLeadsLocality(candidate.country)

	return leads ? (PLACETYPE_SPECIFICITY["postalcode"] ?? Number.NEGATIVE_INFINITY) : AREA_GRADE_POSTALCODE_SPECIFICITY
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
