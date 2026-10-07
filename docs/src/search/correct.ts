/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typo correction against the index vocabulary. The trigram table over `terms` proposes candidates
 *   that share character windows with the token. The edit distance decides whether one is close enough.
 *   A term that shares no three-character window with the token is never proposed, so a transposition
 *   inside a word of four letters or fewer is not corrected.
 */

import type { SearchDatabase } from "./database.ts"
import { quoteTerm } from "./lexical.ts"

const MIN_TOKEN = 3
const CANDIDATES = 10
const SHORT_TOKEN = 6
const MAX_EDITS = 2
const MAX_EDITS_SHORT = 1
const TRIGRAM = 3

const CANDIDATE_SQL = `SELECT t.term FROM terms_trigram JOIN terms t ON t.rowid = terms_trigram.rowid
 WHERE terms_trigram MATCH ? ORDER BY bm25(terms_trigram), t.documents DESC LIMIT ${CANDIDATES}`

/**
 * Edit distance counting insertions, deletions, substitutions and adjacent transpositions as one edit each.
 */
export function damerauLevenshtein(a: string, b: string): number {
	const rows = a.length + 1
	const cols = b.length + 1

	const d: number[][] = Array.from({ length: rows }, (_row, i) =>
		Array.from({ length: cols }, (_column, j) => (i === 0 ? j : j === 0 ? i : 0))
	)

	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1

			d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)

			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
			}
		}
	}

	return d[rows - 1]![cols - 1]!
}

function trigramExpression(token: string): string | null {
	const windows = new Set<string>()
	const characters = [...token.toLowerCase()]

	for (let start = 0; start + TRIGRAM <= characters.length; start++) {
		windows.add(characters.slice(start, start + TRIGRAM).join(""))
	}

	return !windows.size ? null : [...windows].map(quoteTerm).join(" OR ")
}

async function correctToken(db: SearchDatabase, token: string): Promise<string | null> {
	// Lengths count code points, as the trigram windows do.
	const length = [...token].length

	if (length < MIN_TOKEN) return null

	const expression = trigramExpression(token)

	if (!expression) return null

	const candidates = await db.query<{ term: string }>(CANDIDATE_SQL, [expression])
	const lower = token.toLowerCase()
	const allowed = length < SHORT_TOKEN ? MAX_EDITS_SHORT : MAX_EDITS
	let best: { term: string; distance: number } | null = null

	for (const { term } of candidates) {
		const distance = damerauLevenshtein(lower, term)

		if (distance === 0) return null

		if (distance <= allowed && (!best || distance < best.distance)) {
			best = { term, distance }
		}
	}

	return best?.term ?? null
}

/**
 * The tokens with each correctable token replaced by its nearest vocabulary term.
 * `null` when no token changed.
 */
export async function correctTokens(db: SearchDatabase, tokens: readonly string[]): Promise<string[] | null> {
	const corrected = await Promise.all(tokens.map(async (token) => (await correctToken(db, token)) ?? token))

	return corrected.some((token, index) => token !== tokens[index]) ? corrected : null
}
