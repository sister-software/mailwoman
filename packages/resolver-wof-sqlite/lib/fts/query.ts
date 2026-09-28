/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Query shaping for the FTS5 lookup: placetype normalization and the match-expression sanitizer.
 */

import type { FindPlaceQuery, WOFPlacetype } from "#types"

export function normalizePlacetypes(p: FindPlaceQuery["placetype"]): WOFPlacetype[] | null {
	if (!p) return null

	return Array.isArray(p) ? p : [p]
}

/**
 * Make an arbitrary user-typed string safe for FTS5 match.
 */
export function sanitizeFTSQuery(text: string, opts?: { fuseTokens?: boolean }): string {
	const out: string[] = []

	for (const rawToken of text.normalize("NFKC").split(/\s+/u)) {
		const trimmed = rawToken.trim()

		if (!trimmed) continue
		const hasPrefixStar = trimmed.endsWith("*")

		// Fused mode deletes intra-token punctuation because postal names are stored in that collapsed shape.
		if (opts?.fuseTokens) {
			const body = trimmed.replaceAll(/[^\p{L}\p{N}]/gu, "")

			if (!body) continue
			out.push(hasPrefixStar ? `${body}*` : `"${body.replaceAll('"', '""')}"`)

			continue
		}

		const parts = trimmed.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length)

		if (!parts.length) continue

		for (let i = 0; i < parts.length; i++) {
			const body = parts[i]!.replaceAll("*", "")

			if (!body) continue
			// The caller's trailing `*` applies only to the final part.
			out.push(hasPrefixStar && i === parts.length - 1 ? `${body}*` : `"${body.replaceAll('"', '""')}"`)
		}
	}

	return out.join(" ")
}
