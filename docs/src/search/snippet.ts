/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The excerpt a hit displays, with the character ranges that matched a query token. The match here is
 *   a case-insensitive substring search. It marks what to emphasize and takes no part in ranking.
 */

/**
 * The most characters a hit's excerpt holds.
 */
export const SNIPPET_LENGTH = 160

/**
 * Characters of context kept before the first match.
 */
const LEAD = 40

function needles(tokens: readonly string[]): string[] {
	return tokens
		.map((token) => token.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase())
		.filter((token) => token !== "")
}

export function snippet(
	content: string,
	tokens: readonly string[]
): { snippet: string; highlights: [start: number, end: number][] } {
	const lower = content.toLowerCase()
	const terms = needles(tokens)
	const first = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0)
	const anchor = first.length ? Math.min(...first) : 0
	const start = Math.max(0, Math.min(anchor - LEAD, content.length - SNIPPET_LENGTH))
	const text = content.slice(start, start + SNIPPET_LENGTH)
	const window = text.toLowerCase()
	const highlights: [number, number][] = []

	for (const term of terms) {
		for (let index = window.indexOf(term); index >= 0; index = window.indexOf(term, index + term.length)) {
			highlights.push([index, index + term.length])
		}
	}

	highlights.sort((a, b) => a[0] - b[0])

	return { snippet: text, highlights }
}
