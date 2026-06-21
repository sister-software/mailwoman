/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CEDEX — Courrier d'Entreprise à Distribution EXceptionnelle (La Poste business routing, NF Z
 *   10-011 §3.4). A CEDEX line replaces the ordinary delivery line for high-volume business
 *   recipients: `75008 PARIS CEDEX 08` — the word CEDEX after the distribution office name,
 *   optionally followed by a 1–2 digit office number. The component is the `CEDEX [NN]` phrase
 *   itself (the schema's `cedex` tag); the preceding postcode/locality keep their own tags.
 *
 *   This slice closes the gap PR #516 documented: the shard builder sourced the shape from SCHEMA.mdx
 *   prose because codex had no cedex home. Now it does — the builder and any future consumer import
 *   from here (the provenance-first discipline: one provenanced source).
 */

/** Matches a CEDEX phrase: the keyword plus an optional 1–2 digit office number. */
export const CEDEX_PATTERN = /\bCEDEX(?:\s+(\d{1,2}))?\b/i

/** A matched CEDEX phrase with its char range and optional office number. */
export interface CedexMatch {
	/** The full matched phrase as it appears ("CEDEX 08", "Cedex"). */
	matched: string
	start: number
	end: number
	/** The office number when present ("08"), undefined for bare CEDEX. */
	office?: string
}

/**
 * Find the CEDEX phrase in a line, if any. Returns the LAST match — a CEDEX line places the phrase
 * terminally (NF Z 10-011), and any earlier occurrence in pathological input is more likely a venue
 * name fragment.
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

/** True when the string is exactly a CEDEX phrase (the component-value validator). */
export function isCedex(input: unknown): boolean {
	if (typeof input !== "string") return false
	const m = input.trim().match(CEDEX_PATTERN)
	return m !== null && m[0].length === input.trim().length
}
