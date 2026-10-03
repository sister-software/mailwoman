/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One query: the lexical rows, a vocabulary correction when they are empty, then the first record of
 *   each page with its snippet. A second ranked list, such as a vector arm, would merge here.
 */

import type { SearchRecord, SearchResponse } from "@mailwoman/react/search/types"

import { correctTokens } from "./correct.ts"
import type { SearchDatabase } from "./database.ts"
import { lexicalRows, queryTokens } from "./lexical.ts"
import { snippet } from "./snippet.ts"

/**
 * The hit count a query returns when the caller names no limit.
 */
export const DEFAULT_LIMIT = 8

/**
 * The most hits a caller may request.
 */
export const MAX_LIMIT = 20

function collapseByURL(ranked: readonly SearchRecord[], limit: number): SearchRecord[] {
	const seen = new Set<string>()
	const kept: SearchRecord[] = []

	for (const record of ranked) {
		if (seen.has(record.url)) continue

		seen.add(record.url)
		kept.push(record)

		if (kept.length === limit) break
	}

	return kept
}

export async function search(db: SearchDatabase, text: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
	const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT)
	let tokens = queryTokens(text)

	if (!tokens.length) return { query: text, hits: [] }

	let rows = await lexicalRows(db, tokens)
	let corrected: string | undefined

	if (!rows.length) {
		const replacement = await correctTokens(db, tokens)

		if (replacement) {
			tokens = replacement
			corrected = replacement.join(" ")
			rows = await lexicalRows(db, tokens)
		}
	}

	const response: SearchResponse = {
		query: text,
		hits: collapseByURL(rows, bounded).map((record) => ({
			url: record.url,
			anchor: record.anchor,
			hierarchy: record.hierarchy,
			...snippet(record.content, tokens),
		})),
	}

	if (corrected !== undefined && response.hits.length) {
		response.corrected = corrected
	}

	return response
}
