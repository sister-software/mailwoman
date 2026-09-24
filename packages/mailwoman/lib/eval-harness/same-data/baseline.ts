/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Baseline resolver for the same-data benchmark.
 *   Selects by exact match, qualifier agreement, similarity, then canonical pool order.
 *   Uses only fixture data and shared normalization; it has no population or prominence score.
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
 * Registered similarity floor; weaker non-exact matches abstain.
 */
export const BASELINE_SIMILARITY_FLOOR = 0.9

/**
 * Score components reported for each candidate.
 */
export interface BaselineScoreComponents {
	/**
	 * 1 when the candidate's folded name equals the subject's folded name.
	 */
	exact: number
	/**
	 * Jaro-Winkler over the two folded names, in [0, 1].
	 */
	similarity: number
	/**
	 * 1 when the query carried a country qualifier the pool resolved, and this candidate sits in that country.
	 */
	countryQualifier: number
	/**
	 * 1 when the query carried a region qualifier the pool resolved, and this
	 * candidate's `parent_id` is that region.
	 */
	regionQualifier: number
	total: number
}

export interface BaselineSelection {
	/**
	 * The chosen candidate's id, or null for an abstention.
	 */
	placeID: string | null
	/**
	 * The subject the baseline resolved on — the deepest admin value in the frozen tree.
	 */
	subject: string | null
	/**
	 * A monotone map of {@link BaselineScoreComponents.total} into [0, 1], for the calibration table.
	 *
	 * Registered as `total / 8` capped at 1, where 8 is the maximum the weights below can reach.
	 */
	confidence: number
	components: BaselineScoreComponents | null
	/**
	 * Why it abstained, when it did.
	 *
	 * Named so an abstention is a claim rather than an omission.
	 */
	abstainedBecause?: "no_admin_node" | "empty_pool" | "below_similarity_floor"
}

/**
 * Registered weights: exact match, country, region, then similarity.
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
 * Return the deepest admin value and its shallower qualifiers.
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
 * Resolve a country qualifier from the pool, or return `null`.
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
 * Resolve a region qualifier from the pool, or return `null`.
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
 * Select deterministically from the pool, or abstain.
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

		// Strictly greater keeps the pool's canonical order as the tie-break.
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
