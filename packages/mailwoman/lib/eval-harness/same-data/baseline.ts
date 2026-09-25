/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Baseline resolver for the same-data benchmark. It scores candidates from fixture data only and uses
 *   neither population nor prominence.
 */

import { collectNodes, type AddressTree } from "@mailwoman/core/decoder"
import { jaroWinkler } from "@mailwoman/match/comparators"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"

import type { SameDataCandidate } from "#eval-harness/same-data/fixture"

/**
 * Admin tags from deepest to broadest.
 */
export const ADMIN_TAG_DEPTH = [
	"locality",
	"dependent_locality",
	"municipality",
	"district",
	"subregion",
	"region",
	"prefecture",
	"country",
] as const

/**
 * Placetypes that represent countries in the candidate pool.
 */
const COUNTRY_PLACETYPES = new Set(["country", "dependency", "disputed"])

/**
 * The registered similarity floor.
 *
 * The baseline abstains when its best non-exact match falls below it.
 */
export const BASELINE_SIMILARITY_FLOOR = 0.9

/**
 * The score components reported for each candidate.
 */
export interface BaselineScoreComponents {
	/**
	 * 1 when the candidate's folded name equals the subject's folded name, otherwise 0.
	 */
	exact: number
	/**
	 * Jaro-Winkler similarity of the two folded names, in [0, 1].
	 */
	similarity: number
	/**
	 * 1 when the pool resolved a country qualifier from the query and the candidate is in that country.
	 */
	countryQualifier: number
	/**
	 * 1 when the pool resolved a region qualifier from the query and the candidate's
	 * `parent_id` is that region.
	 */
	regionQualifier: number
	total: number
}

/**
 * The baseline's selection for one query.
 */
export interface BaselineSelection {
	/**
	 * The chosen candidate's ID, or null when the baseline abstains.
	 */
	placeID: string | null
	/**
	 * The deepest admin value in the frozen tree.
	 */
	subject: string | null
	/**
	 * The total score divided by the maximum possible total, for the calibration table.
	 */
	confidence: number
	components: BaselineScoreComponents | null
	/**
	 * The reason for an abstention.
	 */
	abstainedBecause?: "no_admin_node" | "empty_pool" | "below_similarity_floor"
}

/**
 * The registered component weights.
 */
const WEIGHT = { exact: 4, countryQualifier: 2, regionQualifier: 1, similarity: 1 } as const

function adminValues(tree: AddressTree): Map<string, string[]> {
	const byTag = new Map<string, string[]>()

	for (const node of collectNodes(tree.roots, (candidate) => candidate.value.trim())) {
		const bucket = byTag.get(node.tag) ?? []

		bucket.push(node.value.trim())
		byTag.set(node.tag, bucket)
	}

	return byTag
}

/**
 * Returns the deepest admin value as the subject and every shallower value as a qualifier.
 */
function subjectAndQualifiers(tree: AddressTree): { subject: string | null; qualifiers: string[] } {
	const byTag = adminValues(tree)
	let subject: string | null = null
	const qualifiers: string[] = []

	for (const tag of ADMIN_TAG_DEPTH) {
		for (const value of byTag.get(tag) ?? []) {
			if (subject === null) {
				subject = value
			} else {
				qualifiers.push(value)
			}
		}
	}

	return { subject, qualifiers }
}

/**
 * Returns the country code of the first qualifier that matches a country in the pool, or `null`.
 */
function countryScopeFromPool(qualifiers: readonly string[], pool: readonly SameDataCandidate[]): string | null {
	for (const qualifier of qualifiers) {
		const key = normalizeLocalityForKey(qualifier)

		for (const candidate of pool) {
			if (!COUNTRY_PLACETYPES.has(candidate.placetype)) continue

			if (normalizeLocalityForKey(candidate.name) === key && candidate.country) return candidate.country
		}

		// Also accept a bare ISO code when the pool contains that country.
		if (/^[a-z]{2}$/u.test(key)) {
			const upper = key.toUpperCase()

			if (pool.some((candidate) => candidate.country === upper)) return upper
		}
	}

	return null
}

/**
 * Returns the ID of the first qualifier that matches a region in the pool, or `null`.
 */
function regionScopeFromPool(qualifiers: readonly string[], pool: readonly SameDataCandidate[]): string | null {
	for (const qualifier of qualifiers) {
		const key = normalizeLocalityForKey(qualifier)

		for (const candidate of pool) {
			if (candidate.placetype !== "region") continue

			if (normalizeLocalityForKey(candidate.name) === key) return String(candidate.id)
		}
	}

	return null
}

/**
 * Selects the highest-scoring candidate from the pool, or abstains.
 *
 * Ties go to the earlier candidate in the pool's canonical order.
 */
export function selectBaseline(tree: AddressTree, pool: readonly SameDataCandidate[]): BaselineSelection {
	const { subject, qualifiers } = subjectAndQualifiers(tree)

	if (subject === null) {
		return { placeID: null, subject: null, confidence: 0, components: null, abstainedBecause: "no_admin_node" }
	}

	if (!pool.length) {
		return { placeID: null, subject, confidence: 0, components: null, abstainedBecause: "empty_pool" }
	}

	const subjectKey = normalizeLocalityForKey(subject)
	const countryScope = countryScopeFromPool(qualifiers, pool)
	const regionScope = regionScopeFromPool(qualifiers, pool)

	let best: { candidate: SameDataCandidate; components: BaselineScoreComponents } | null = null

	for (const candidate of pool) {
		const candidateKey = normalizeLocalityForKey(candidate.name)
		const exact = candidateKey === subjectKey ? 1 : 0
		const similarity = exact === 1 ? 1 : jaroWinkler(subjectKey, candidateKey)
		const countryQualifier = countryScope !== null && candidate.country === countryScope ? 1 : 0
		const regionQualifier = regionScope !== null && String(candidate.parent_id ?? "") === regionScope ? 1 : 0

		const components: BaselineScoreComponents = {
			exact,
			similarity,
			countryQualifier,
			regionQualifier,
			total:
				WEIGHT.exact * exact +
				WEIGHT.countryQualifier * countryQualifier +
				WEIGHT.regionQualifier * regionQualifier +
				WEIGHT.similarity * similarity,
		}

		// A strict comparison keeps the earlier candidate on a tie.
		if (!best || components.total > best.components.total) {
			best = { candidate, components }
		}
	}

	if (!best) {
		return { placeID: null, subject, confidence: 0, components: null, abstainedBecause: "empty_pool" }
	}

	if (best.components.exact === 0 && best.components.similarity < BASELINE_SIMILARITY_FLOOR) {
		return {
			placeID: null,
			subject,
			confidence: 0,
			components: best.components,
			abstainedBecause: "below_similarity_floor",
		}
	}

	const maximum = WEIGHT.exact + WEIGHT.countryQualifier + WEIGHT.regionQualifier + WEIGHT.similarity

	return {
		placeID: String(best.candidate.id),
		subject,
		confidence: Math.min(1, best.components.total / maximum),
		components: best.components,
	}
}
