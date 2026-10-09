/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The lexical query. Every token of the user's text becomes a quoted FTS5 string, so the text never
 *   reaches the FTS5 parser as an operator, a column filter or a bare `*`.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import type { SearchRecord } from "@mailwoman/react/search/types"

import type { SearchDatabase } from "./database.ts"

/**
 * The most rows one lexical query reads, before the rows collapse to one hit per page.
 */
export const LEXICAL_ROWS = 40

/**
 * `bm25` column weights: a match in the heading path counts ten times a match in the content.
 */
const HEADINGS_WEIGHT = 10
const CONTENT_WEIGHT = 1

/**
 * The level the extractor gives a table row.
 */
const TABLE_ROW_LEVEL = 5

/**
 * The share of its `bm25` score a table row keeps.
 *
 * A row's headings column is a few words, so its score is large under length normalization.
 * The factor keeps a matching page or section heading above a matching option name.
 */
const TABLE_ROW_SCORE_FACTOR = 0.5

interface RecordRow {
	id: string
	url: string
	anchor: string
	hierarchy: string
	content: string
	level: number
	position: number
}

const SQL = `SELECT r.id, r.url, r.anchor, r.hierarchy, r.content, r.level, r.position
 FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
 WHERE records_fts MATCH ?
 ORDER BY bm25(records_fts, ${HEADINGS_WEIGHT}, ${CONTENT_WEIGHT})
   * (CASE WHEN r.level = ${TABLE_ROW_LEVEL} THEN ${TABLE_ROW_SCORE_FACTOR} ELSE 1 END), r.level, r.position
 LIMIT ${LEXICAL_ROWS}`

export function quoteTerm(text: string): string {
	return `"${text.replaceAll('"', '""')}"`
}

/**
 * The whitespace-separated parts of the text that the tokenizer can index: those with a letter or a digit.
 */
export function queryTokens(text: string): string[] {
	return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token))
}

export function matchExpression(tokens: readonly string[]): string | null {
	if (!tokens.length) return null

	return tokens
		.map((token, index) => (index === tokens.length - 1 ? `${quoteTerm(token)}*` : quoteTerm(token)))
		.join(" ")
}

export async function lexicalRows(db: SearchDatabase, tokens: readonly string[]): Promise<SearchRecord[]> {
	const expression = matchExpression(tokens)

	if (!expression) return []

	const rows = await db.query<RecordRow>(SQL, [expression])

	return rows.map((row) => ({ ...row, hierarchy: parseJSONStrict<(string | null)[]>(row.hierarchy) }))
}
