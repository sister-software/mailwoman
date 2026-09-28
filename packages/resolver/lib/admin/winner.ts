/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Which resolved admin place answers the query: the one ordering whose postcode rung is not a constant.
 *
 *   `postalcode` is the only placetype whose specificity depends on the resolved hit.
 *   `PLACETYPE_SPECIFICITY` cannot express that split.
 */

import { areaPostcodeLeadsLocality, isUnitGradePostcodeHit } from "@mailwoman/codex"
import type { AddressNode } from "@mailwoman/core/decoder"
import { PLACETYPE_SPECIFICITY } from "@mailwoman/core/resources/whosonfirst/specificity"

/**
 * The admin fallback order when the postcode leads, with the JP rungs beside their
 * Latin counterparts and `municipality` above `district`.
 */
export const ADMIN_LADDER_POSTCODE_FIRST: ReadonlyArray<string> = [
	"postcode",
	"locality",
	"municipality",
	"dependent_locality",
	"district",
	"subregion",
	"region",
	"prefecture",
	"country",
]

/**
 * The admin fallback order everywhere else: the locality tiers lead
 * and the postcode sits between them and `region`.
 */
export const ADMIN_LADDER_LOCALITY_FIRST: ReadonlyArray<string> = [
	"locality",
	"municipality",
	"dependent_locality",
	"district",
	"postcode",
	"subregion",
	"region",
	"prefecture",
	"country",
]

/**
 * The resolved postcode a ladder decision reads.
 *
 * It contains the parsed span and the resolver hit.
 * It also contains the country where the resolver placed the postcode.
 */
export interface ResolvedPostcodeHit {
	value: string
	resolverName: string | undefined
	/**
	 * ISO-3166 alpha-2 code where the resolver placed the postcode.
	 *
	 * The code is independent of the caller's requested scope.
	 * It is absent when the postcode did not resolve to a country.
	 * The ladder then defaults to locality-first.
	 */
	country?: string
}

/**
 * Pick the admin fallback order for one resolved tree: postcode-first when the code is
 * unit-grade or the address system's area-grade codes are finer than its localities.
 */
export function adminLadderFor(postcode: ResolvedPostcodeHit | undefined): ReadonlyArray<string> {
	if (postcode === undefined) return ADMIN_LADDER_LOCALITY_FIRST

	const leads =
		isUnitGradePostcodeHit(postcode.value, postcode.resolverName) || areaPostcodeLeadsLocality(postcode.country)

	return leads ? ADMIN_LADDER_POSTCODE_FIRST : ADMIN_LADDER_LOCALITY_FIRST
}

/**
 * The ladder for a flat list of resolved nodes, reading `country` from the resolver's
 * placement rather than a caller's requested scope.
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
 * Deliberately non-integer position for an area-grade postal code on `PLACETYPE_SPECIFICITY`:
 * below the whole locality tier and above `county` (2).
 */
export const AREA_GRADE_POSTALCODE_SPECIFICITY = 2.5

/**
 * A resolved place, as much of it as an ordering decision reads.
 */
export interface ResolvedSpecificityInput {
	placetype: string
	/**
	 * ISO-3166 alpha-2 the resolver placed this candidate in, read only for a `postalcode`.
	 */
	country?: string
	/**
	 * The parsed span.
	 * Absent for a non-postcode candidate.
	 */
	value?: string
	/**
	 * The resolver's own hit name, as `resolver_name` metadata carries it.
	 */
	resolverName?: string
}

/**
 * Rank a resolved place for "whose coordinate answers the query": `PLACETYPE_SPECIFICITY`,
 * except that a `postalcode` is ranked by its hit and an unranked placetype returns `-Infinity`.
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
 * The best of a resolved set under {@link resolvedSpecificity}, or `null` when the set is empty.
 *
 * Ties keep the first.
 * `toInput` is explicit because each consumer formats the resolver's hit differently.
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
