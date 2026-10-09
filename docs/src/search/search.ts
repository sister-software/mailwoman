/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One query: the lexical rows, a vocabulary correction when they are empty, then one hit per section
 *   with a cap per page, each with its snippet. A second ranked list, such as a vector arm, would merge here.
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

/**
 * The most sections of one page that a response holds, so one long page cannot fill the list.
 */
export const HITS_PER_PAGE = 3

/**
 * One hit per section, at most {@link HITS_PER_PAGE} per page, in rank order.
 */
export function collapseBySection(ranked: readonly SearchRecord[], limit: number): SearchRecord[] {
	const sections = new Set<string>()
	const perPage = new Map<string, number>()
	const kept: SearchRecord[] = []

	for (const record of ranked) {
		const section = `${record.url}#${record.anchor}`
		const onPage = perPage.get(record.url) ?? 0

		if (sections.has(section) || onPage >= HITS_PER_PAGE) continue

		sections.add(section)
		perPage.set(record.url, onPage + 1)
		kept.push(record)

		if (kept.length === limit) break
	}

	return kept
}

/**
 * The word the index text shows for a corrected token.
 *
 * The vocabulary holds porter stems.
 * A correction such as `geocod` is shown as the most frequent hit word that begins with it.
 * A stem with no such word is shown as itself.
 */
export function surfaceWord(stem: string, rows: readonly SearchRecord[]): string {
	const lower = stem.toLowerCase()
	const counts = new Map<string, number>()

	for (const row of rows) {
		const text = `${row.hierarchy.filter((entry) => entry !== null).join(" ")} ${row.content}`

		for (const word of text.match(/[\p{L}\p{N}'-]+/gu) ?? []) {
			const folded = word.toLowerCase()

			if (folded.startsWith(lower)) {
				counts.set(folded, (counts.get(folded) ?? 0) + 1)
			}
		}
	}

	let best = stem
	let bestCount = 0

	for (const [word, count] of counts) {
		if (count > bestCount || (count === bestCount && word.length < best.length)) {
			best = word
			bestCount = count
		}
	}

	return best
}

export async function search(db: SearchDatabase, text: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
	const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT)
	const typed = queryTokens(text)
	let tokens = typed

	if (!tokens.length) return { query: text, corrected: null, hits: [] }

	let rows = await lexicalRows(db, tokens)
	let replacement: string[] | null = null

	if (!rows.length) {
		replacement = await correctTokens(db, tokens)

		if (replacement) {
			tokens = replacement
			rows = await lexicalRows(db, tokens)
		}
	}

	const hits = collapseBySection(rows, bounded).map((record) => ({
		url: record.url,
		anchor: record.anchor,
		hierarchy: record.hierarchy,
		...snippet(record.content, tokens),
	}))

	const corrected =
		replacement && hits.length
			? replacement.map((token, index) => (token === typed[index] ? token : surfaceWord(token, rows))).join(" ")
			: null

	return { query: text, corrected, hits }
}
