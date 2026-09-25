/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Matches Exhibit 21 subsidiary names to Form 499 filers by canonical name and scores each match.
 */

import { canonicalizeOrganizationName } from "@mailwoman/record"

/**
 * Score for byte-identical raw names.
 *
 * It stays below 1 because two companies can share a name.
 */
export const EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME = 0.9

/**
 * Score for names that differ only in formatting and share the same legal designations.
 */
export const EDGAR_MATCH_SCORE_NORMALIZATION_ONLY = 0.75

/**
 * Score for names whose legal designations differ, such as "LLC" and "Inc.".
 */
export const EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS = 0.5

/**
 * Returns a sorted key of the legal designations that canonicalization removes from a name.
 */
export function strippedDesignationKey(name: string): string {
	return (canonicalizeOrganizationName(name)?.designations ?? []).toSorted().join(" ")
}

/**
 * Scores a subsidiary-name match by comparing the raw names and their legal designations.
 *
 * The score has three fixed levels.
 * String similarity would rate "X LLC" and "X Inc." as near-identical even
 * though the designations identify different entities.
 */
export function scoreEdgarSubsidiaryMatch(subsidiaryName: string, legalName: string): number {
	if (subsidiaryName === legalName) return EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME

	return strippedDesignationKey(subsidiaryName) === strippedDesignationKey(legalName)
		? EDGAR_MATCH_SCORE_NORMALIZATION_ONLY
		: EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS
}

/**
 * One FRN and its original legal name within a canonical-name group.
 */
export interface CanonicalNameCandidate {
	frn: string
	legalName: string
}

/**
 * Groups FRNs by canonical legal name.
 *
 * Each group keeps every FRN so callers can skip a name that several filers share.
 */
export function groupFRNsByCanonicalLegalName(
	legalNameByFRN: ReadonlyMap<string, { name: string; filedAt: string }>
): Map<string, CanonicalNameCandidate[]> {
	const buckets = new Map<string, CanonicalNameCandidate[]>()

	for (const [frn, { name }] of legalNameByFRN) {
		const canonical = canonicalizeOrganizationName(name)?.canonical

		if (!canonical) continue

		const candidate: CanonicalNameCandidate = { frn, legalName: name }
		const bucket = buckets.get(canonical)

		if (bucket) {
			bucket.push(candidate)
		} else {
			buckets.set(canonical, [candidate])
		}
	}

	return buckets
}
