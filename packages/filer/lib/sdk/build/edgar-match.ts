/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Matching an Exhibit 21 subsidiary name to a Form 499 filer, and grading how much that match knows.
 *
 *   The join is on the CANONICALIZED organization name, which is what makes the match possible and what limits it:
 *   `canonicalizeOrganizationName` maps `"American Broadband LLC"`, `"American Broadband, Inc."` and `"American
 *   Broadband Corp"` all onto `"american broadband"` (verified), so a canonical hit provably cannot tell three
 *   companies apart. Grouping therefore keeps the FULL bucket per canonical name, so a caller can abstain on a
 *   collision, and the score grades what the canonical form threw away. The two answer different questions — WHETHER
 *   to write an edge, versus how far to trust the one written — and neither substitutes for the other.
 */

import { canonicalizeOrganizationName } from "@mailwoman/record"

/**
 * The subsidiary-name→FRN score when the two RAW names are BYTE-IDENTICAL — the strongest this match can ever be, and
 * the CEILING for {@linkcode scoreEdgarSubsidiaryMatch}.
 *
 * **It is not 1, and it is bounded by what canonical-name matching can know, which is less than identity.** Two
 * disjoint companies can file under the same legal name; `edgar-filings.ts`'s `resolveCIKCandidates` docstring pins
 * that case verbatim (`"American Broadband LLC"` and `"American Broadband, Inc."`, disjoint CIKs) and says in terms
 * that "a score of `1` is not itself a license to pick". A name is evidence about identity, never a proof of it, so no
 * value on this ladder may read as certainty.
 */
export const EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME = 0.9

/**
 * The score when the two raw names differ only in what canonicalization normalizes WITHOUT deleting — case,
 * punctuation, accents, `&`/`and`, a leading `The`, whitespace — while carrying the SAME legal designations (`"ACME
 * FIBER, LLC"` vs `"Acme Fiber LLC"`). Real formatting variance between two filings of one company's name, so
 * meaningfully weaker than a byte-identical match but not the ambiguous case below.
 */
export const EDGAR_MATCH_SCORE_NORMALIZATION_ONLY = 0.75

/**
 * The score when the two raw names differ in their LEGAL DESIGNATIONS — `"American Broadband LLC"` (499) vs `"American
 * Broadband, Inc."` (Exhibit 21). Weak on purpose: canonicalization is what erased the only part of the string that
 * distinguished them, so the match is resting on a token it deliberately threw away. The abstention in
 * {@linkcode processEdgarSubsidiaryRow} (`matchedFRNs.length !== 1`) does NOT cover this — it only fires on a collision
 * WITHIN the 499 file, so when 499 carries only the LLC and Exhibit 21 discloses the Inc., exactly one FRN matches and
 * the edge is written. That edge may well be the wrong company; this number says so.
 */
export const EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS = 0.5

/**
 * The sorted legal designations {@linkcode canonicalizeOrganizationName} STRIPPED from a name, as a comparable key.
 * Sorted (not encounter-ordered) because `"Acme Co Inc"` and `"Acme Inc Co"` deleted the same tokens.
 */
export function strippedDesignationKey(name: string): string {
	return (canonicalizeOrganizationName(name)?.designations ?? []).toSorted().join(" ")
}

/**
 * The `match_score` for one subsidiary-name→FRN inference — graded per match, never one flat constant across every such
 * link regardless of how much the match actually knows.
 *
 * Both names reaching this function already share a canonical form; that is the match. The question this answers is how
 * much of the ORIGINAL string that shared form threw away, because `canonicalizeOrganizationName` maps `"American
 * Broadband LLC"`, `"American Broadband, Inc."` and `"American Broadband Corp"` all to `"american broadband"`
 * (verified). A match that provably cannot tell three companies apart must not report the same confidence as one on
 * identical raw names.
 *
 * **`@mailwoman/match`'s comparators were checked first and are the wrong instrument here — measured, not assumed.**
 * `nameSimilarity` on the RAW pair scores `"American Broadband LLC"` vs `"American Broadband, Inc."` at **0.9485** and
 * vs `"American Broadband Corp"` at **0.9557** — HIGHER than a flat 0.92 would be, because Jaro-Winkler's prefix boost
 * rewards exactly the long shared head these pairs have. String distance measures how alike two spellings look; the
 * signal that separates a real match from a designation collision is WHICH TOKENS canonicalization deleted, which is a
 * set comparison. So this uses `canonicalizeOrganizationName`'s own `designations` output — already computed on this
 * path, no new dependency — rather than a comparator that would score the ambiguous case highest of all.
 *
 * Three outcomes, no interpolation: a similarity curve here would imply a resolution this evidence does not have.
 */
export function scoreEdgarSubsidiaryMatch(subsidiaryName: string, legalName: string): number {
	if (subsidiaryName === legalName) return EDGAR_MATCH_SCORE_IDENTICAL_RAW_NAME

	return strippedDesignationKey(subsidiaryName) === strippedDesignationKey(legalName)
		? EDGAR_MATCH_SCORE_NORMALIZATION_ONLY
		: EDGAR_MATCH_SCORE_DESIGNATION_DIFFERS
}

/**
 * One FRN in a canonical-name bucket, carrying the RAW `legalNameOfCarrier` spelling that landed it there. The raw name
 * is what {@linkcode scoreEdgarSubsidiaryMatch} needs: the canonical form is by definition identical across every member
 * of a bucket, so it holds none of the signal that separates a real match from a designation collision.
 */
export interface CanonicalNameCandidate {
	frn: string
	legalName: string
}

/**
 * Groups `legalNameByFRN` (the in-memory map {@linkcode buildFilerDatabase}'s form499 loop builds) by CANONICAL name —
 * "which FRNs share this exact canonical legal name" — the input {@linkcode processEdgarSubsidiaryRow}'s corroboration
 * match reads. A canonical name shared by two or more distinct FRNs is a genuine collision (the same
 * false-identity-link hazard `edgar-filings.ts`'s `resolveCIKCandidates` documents), so the caller must see the FULL
 * bucket rather than just "the first match" — abstaining on a multi-member bucket is `processEdgarSubsidiaryRow`'s job,
 * not this function's.
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
