/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   cedex — Courrier d'Entreprise à Distribution EXceptionnelle (La Poste business routing, NF Z
 *   10-011 §3.4). A cedex line replaces the ordinary delivery line for high-volume business
 *   recipients: `75008 paris cedex 08` — the word cedex after the distribution office name,
 *   optionally followed by a 1–2 digit office number. The component is the `cedex [NN]` phrase
 *   itself (the schema's `cedex` tag); the preceding postcode/locality keep their own tags.
 *
 *   This module closes the gap PR #516 documented: the extract builder sourced the shape from schema.mdx
 *   prose because codex had no cedex home. Now it does — the builder and any future consumer import
 *   from here (the provenance-first discipline: one provenanced source).
 */

/**
 * Matches a cedex phrase: the keyword plus an optional 1–2 digit office number.
 */
export const CEDEX_PATTERN = /\bCEDEX(?:\s+(\d{1,2}))?\b/i

/**
 * A matched cedex phrase with its char range and optional office number.
 */
export interface CedexMatch {
	/**
	 * The full matched phrase as it appears ("cedex 08", "Cedex").
	 */
	matched: string
	start: number
	end: number
	/**
	 * The office number when present ("08"), undefined for bare cedex.
	 */
	office?: string
}

/**
 * Find the cedex phrase in a line, if any.
 *
 * Returns the last match — a cedex line places the phrase terminally (NF Z 10-011),
 * and any earlier occurrence in pathological input is more likely a venue name fragment.
 */
export function matchCedex(text: string): CedexMatch | null {
	let match: CedexMatch | null = null
	const re = new RegExp(CEDEX_PATTERN.source, "gi")

	for (const m of text.matchAll(re)) {
		match = {
			matched: m[0],
			start: m.index,
			end: m.index + m[0].length,
			...(m[1] ? { office: m[1] } : {}),
		}
	}

	return match
}

/**
 * True when the string is exactly a cedex phrase (the component-value validator).
 */
export function isCedex(input: unknown): boolean {
	if (typeof input !== "string") return false
	const m = input.trim().match(CEDEX_PATTERN)

	return m !== null && m[0].length === input.trim().length
}
