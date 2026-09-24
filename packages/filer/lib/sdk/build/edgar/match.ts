/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Match Exhibit 21 subsidiary names to Form 499 filers and score the strength of each canonical-name match.
 *   Canonicalization maps names such as `"American Broadband LLC"` and `"American Broadband, Inc."` to the same key.
 *   Keep all FRNs per key so callers can abstain on collisions; score how much the canonical form discarded.
 */

import { canonicalizeOrganizationName } from "@mailwoman/record"

/**
 * Maximum score for byte-identical raw names.
 *
 * It remains below 1 because name equality is evidence, not proof, of identity.
 */
export const EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME = 0.9

/**
 * Score for names differing only in formatting normalized by canonicalization,
 * with the same legal designations.
 */
export const EDGAR_MATCH_SCORE_NORMALIZATION_ONLY = 0.75

/**
 * Score for names whose legal designations differ.
 *
 * Canonicalization removed the distinguishing token, so the match is ambiguous.
 */
export const EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS = 0.5

/**
 * Return a stable key for the legal designations removed during canonicalization.
 */
export function strippedDesignationKey(name: string): string {
	return (canonicalizeOrganizationName(name)?.designations ?? []).toSorted().join(" ")
}

/**
 * Score a subsidiary-name match from raw-name identity and the legal designations
 * removed by canonicalization.
 *
 * String similarity is unsuitable: Jaro-Winkler scored the LLC/Inc. and LLC/Corp.
 * examples 0.9485 and 0.9557 despite the designation collision.
 * Use the canonicalizer's existing designation output and three discrete score levels;
 * interpolating would imply evidence this match does not provide.
 */
export function scoreEdgarSubsidiaryMatch(subsidiaryName: string, legalName: string): number {
	if (subsidiaryName === legalName) return EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME

	return strippedDesignationKey(subsidiaryName) === strippedDesignationKey(legalName)
		? EDGAR_MATCH_SCORE_NORMALIZATION_ONLY
		: EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS
}

/**
 * FRN and original legal name for one canonical-name bucket entry.
 */
export interface CanonicalNameCandidate {
	frn: string
	legalName: string
}

/**
 * Group FRNs by canonical legal name.
 *
 * Return the full bucket so callers can abstain when distinct FRNs collide.
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
