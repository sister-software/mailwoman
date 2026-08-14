/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Query shaping for the FTS5 lookup: placetype normalization and the MATCH-expression sanitizer.
 *   Both turn a caller's loose input into something SQLite's FTS5 parser accepts without throwing —
 *   an unescaped quote or a bare `*` is a syntax error, not an empty result.
 */

import type { FindPlaceQuery, WOFPlacetype } from "./types.ts"

export function normalizePlacetypes(p: FindPlaceQuery["placetype"]): WOFPlacetype[] | null {
	if (!p) return null

	return Array.isArray(p) ? p : [p]
}

/**
 * Make an arbitrary user-typed string safe for FTS5 MATCH.
 *
 * FTS5 has its own query syntax (`"phrase"`, `term1 OR term2`, `prefix*`, NEAR/N, etc.). Letting raw user input through
 * means a user typing `Paris's` or `St. (Petersburg)` causes a syntax error.
 *
 * Per-token rules:
 *
 * - Strip all punctuation except trailing `*` from each whitespace-separated token.
 * - **Trailing `*`** is preserved as FTS5 **prefix syntax** — `627*` becomes the literal `627*` (unquoted). The caller
 *   signaled they want a prefix; respect that.
 * - All other tokens are wrapped in `"..."` as a single-word phrase. Conservative — handles apostrophes, parens, accented
 *   input, etc. safely.
 * - Multiple tokens join with implicit AND.
 *
 * Examples:
 *
 * - `"Paris"` → `"Paris"` (phrase)
 * - `"627*"` → `627*` (prefix)
 * - `"St. (Petersburg)"` → `"St" "Petersburg"` (two phrases, AND-joined)
 * - `"Thiron-Gardais"` → `"Thiron" "Gardais"` (intra-token punctuation SPLITS — #945; fusing to `ThironGardais` matched
 *   nothing because the FTS doc tokenizes the hyphenated name as two terms)
 * - `"110 00"` with `fuseTokens` (postcode-typed) → `"110" "00"` per-token fused — the #920 name law
 * - `"Pari* TX"` → `Pari* "TX"` (mixed prefix + phrase)
 * - `"*"` alone → `""` (no body → drop)
 */
export function sanitizeFTSQuery(text: string, opts?: { fuseTokens?: boolean }): string {
	const out: string[] = []

	for (const rawToken of text.normalize("NFKC").split(/\s+/u)) {
		const trimmed = rawToken.trim()

		if (!trimmed) continue
		const hasPrefixStar = trimmed.endsWith("*")

		// #920 name law (postcode-typed queries ONLY): delete intra-token punctuation and FUSE the
		// remainder — postal names are stored in this collapsed shape ("SW1A" stays one term).
		if (opts?.fuseTokens) {
			const body = trimmed.replaceAll(/[^\p{L}\p{N}]/gu, "")

			if (!body) continue
			out.push(hasPrefixStar ? `${body}*` : `"${body.replaceAll('"', '""')}"`)

			continue
		}

		// Everything else SPLITS on intra-token punctuation — the behavior the docstring always
		// promised ("St. (Petersburg)" → two phrases). The old code DELETED punctuation instead,
		// fusing "Thiron-Gardais" into the unmatchable single term `ThironGardais` while the FTS
		// doc holds two terms (#945 — the entire hyphenated-name class missed at the raw lookup;
		// masked for years because pre-splice tokenizers never emitted hyphen-preserved values).
		const parts = trimmed.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

		if (!parts.length) continue

		for (let i = 0; i < parts.length; i++) {
			const body = parts[i]!.replaceAll("*", "")

			if (!body) continue
			// The caller's trailing `*` applies to the FINAL part ("Thiron-Gard*" → "Thiron" Gard*).
			out.push(hasPrefixStar && i === parts.length - 1 ? `${body}*` : `"${body.replaceAll('"', '""')}"`)
		}
	}

	return out.join(" ")
}
