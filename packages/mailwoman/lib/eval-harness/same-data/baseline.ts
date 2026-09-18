/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The registered baseline resolver for the same-data benchmark (#2261): exact component agreement
 *   first, then normalized name similarity, then the fixture's canonical candidate order.
 *
 *   It reads the fixture and nothing else: no network, no gazetteer, no ancestry sidecar, no population
 *   prior. A qualifier is resolved inside the pool — the country token is matched against the pool's own
 *   country-placetype candidates and the ISO code read off the winner — so `Whitby, United Kingdom` resolves
 *   without a country table, and every fact used is one the production arm also received. A baseline that
 *   could not read a qualifier would lose the homograph stratum to its own blindness rather than to the
 *   mechanism being measured.
 *
 *   No population, importance, prominence or referential term appears below. That absence is the comparison:
 *   the production resolver's fame-anchored ranking is one of the things under test, so the baseline must
 *   not hold a copy of it.
 *
 *   `normalizeLocalityForKey` is imported rather than re-typed. A baseline folding names differently would
 *   measure normalization rather than selection, and three fake gazetteers have already drifted on that
 *   fold (#1764).
 */

import { collectNodes, type AddressTree } from "@mailwoman/core/decoder"
import { jaroWinkler } from "@mailwoman/match/comparators"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street/normalize"

import type { SameDataCandidate } from "#eval-harness/same-data/fixture"

/**
 * Admin tags deepest-first. The same order the frozen ruler's `selectedCandidateRule` declares, so the baseline's
 * subject and the scored arm's selection are read off the tree the same way.
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
 * Placetypes that can carry a country scope, as the pool spells them.
 */
const COUNTRY_PLACETYPES = new Set(["country", "dependency", "disputed"])

/**
 * The similarity floor below which the baseline abstains rather than selecting its best partial match. Registered, not
 * tuned: a resolver that always answers cannot be measured on abstention, and a floor chosen after results would be the
 * decision rule moving.
 */
export const BASELINE_SIMILARITY_FLOOR = 0.9

/**
 * The score components the baseline reports for every candidate it considered, so a reader can see why it chose.
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
	 * 1 when the query carried a region qualifier the pool resolved, and this candidate's `parent_id` is that region.
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
	 * A monotone map of {@link BaselineScoreComponents.total} into [0, 1], for the calibration table. Registered as `total
	 * / 8` capped at 1, where 8 is the maximum the weights below can reach.
	 */
	confidence: number
	components: BaselineScoreComponents | null
	/**
	 * Why it abstained, when it did. Named so an abstention is a claim rather than an omission.
	 */
	abstainedBecause?: "no_admin_node" | "empty_pool" | "below_similarity_floor"
}

/**
 * The weights, registered. Exact agreement outranks any qualifier. a qualifier outranks similarity. similarity breaks
 * what remains, and the pool's canonical order breaks an exact tie.
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
 * The deepest admin value in the tree, and every shallower admin value beside it.
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
 * The ISO country the pool's own country candidates give a qualifier, or null.
 */
function countryScopeFromPool(qualifiers: readonly string[], pool: readonly SameDataCandidate[]): string | null {
	for (const qualifier of qualifiers) {
		const key = normalizeLocalityForKey(qualifier)

		for (const candidate of pool) {
			if (!COUNTRY_PLACETYPES.has(candidate.placetype)) continue

			if (normalizeLocalityForKey(candidate.name) === key && candidate.country) return candidate.country
		}

		// A bare ISO code never reaches a country candidate by name, and it is the form a region-qualified row's
		// country half most often takes.
		if (/^[a-z]{2}$/u.test(key)) {
			const upper = key.toUpperCase()

			if (pool.some((candidate) => candidate.country === upper)) return upper
		}
	}

	return null
}

/**
 * The pool id of a region candidate one of the qualifiers names, or null. Used as a one-level containment check: the
 * baseline has no ancestry, so it can only ask whether a candidate's immediate parent is the named region.
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
 * Select from the pool, or abstain. Deterministic: the pool arrives in canonical order and every tie is broken by that
 * order, so two runs over one fixture answer identically.
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
