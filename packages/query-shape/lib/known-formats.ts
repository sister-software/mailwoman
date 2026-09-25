/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { KnownFormat, KnownFormatHit, TokenClass } from "#types"

/**
 * One structural postcode pattern and the format it identifies.
 */
interface FormatPattern {
	format: KnownFormat
	/**
	 * The pattern tested against one token's body, or against two token bodies joined by a space.
	 */
	pattern: RegExp
	/**
	 * The number of tokens the pattern covers.
	 */
	tokenSpan: 1 | 2
	/**
	 * The confidence without locale context.
	 * Ambiguous patterns score lower.
	 */
	confidence: number
}

const PATTERNS: ReadonlyArray<FormatPattern> = [
	{ format: "us_zip4", pattern: /^\d{5}-\d{4}$/, tokenSpan: 1, confidence: 0.95 },
	{ format: "ca_postcode", pattern: /^[A-Z]\d[A-Z]\d[A-Z]\d$/i, tokenSpan: 1, confidence: 0.95 },
	// Japanese postcodes are often written with a leading 〒 (U+3012), and the
	// tokenizer keeps it attached to the digits.
	{ format: "jp_postcode", pattern: /^〒?\d{3}-\d{4}$/, tokenSpan: 1, confidence: 0.95 },
	// A UK postcode is two tokens when written with a space, as in "SW1A 1AA".
	{ format: "uk_postcode", pattern: /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/i, tokenSpan: 1, confidence: 0.9 },
	{ format: "uk_postcode", pattern: /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/i, tokenSpan: 2, confidence: 0.9 },
	{ format: "ca_postcode", pattern: /^[A-Z]\d[A-Z] \d[A-Z]\d$/i, tokenSpan: 2, confidence: 0.9 },
	// A Dutch postcode is four digits followed by two letters.
	{ format: "nl_postcode", pattern: /^\d{4} [A-Z]{2}$/i, tokenSpan: 2, confidence: 0.9 },
	{ format: "nl_postcode", pattern: /^\d{4}[A-Z]{2}$/i, tokenSpan: 1, confidence: 0.9 },
	// Five digits are ambiguous between the US, France and Germany.
	// Every matching format is reported at reduced confidence, and the caller chooses by locale.
	{ format: "us_zip", pattern: /^\d{5}$/, tokenSpan: 1, confidence: 0.6 },
	{ format: "fr_postcode", pattern: /^\d{5}$/, tokenSpan: 1, confidence: 0.6 },
	{ format: "de_postcode", pattern: /^\d{5}$/, tokenSpan: 1, confidence: 0.6 },
	// The spaced form `NNN NN` is shared by Czechia, Slovakia, Sweden and Greece, so every one is reported.
	// The unspaced form already matches the five-digit patterns above.
	{ format: "cz_postcode", pattern: /^\d{3} \d{2}$/, tokenSpan: 2, confidence: 0.6 },
	{ format: "sk_postcode", pattern: /^\d{3} \d{2}$/, tokenSpan: 2, confidence: 0.6 },
	{ format: "se_postcode", pattern: /^\d{3} \d{2}$/, tokenSpan: 2, confidence: 0.6 },
	{ format: "gr_postcode", pattern: /^\d{3} \d{2}$/, tokenSpan: 2, confidence: 0.6 },
	// `detectPoBox` handles PO boxes because they can span more than two tokens.
]

const PO_BOX_LEADERS = new Set(["po", "p.o.", "p.o", "box", "bp", "b.p.", "b.p", "casilla", "apartado"])

/**
 * Whether a known-format name is a postcode format.
 *
 * The check uses the naming convention `us_zip`, `us_zip4` or `<cc>_postcode` instead of a set.
 * `@mailwoman/core` cannot depend on this package but reads the same names,
 * so a new format becomes a postcode everywhere once it follows the convention.
 *
 * A test checks every entry in `PATTERNS` against this function.
 */
export function isPostcodeFormat(format: string): boolean {
	return format === "us_zip" || format === "us_zip4" || format.endsWith("_postcode")
}

/**
 * Detects known postcode and PO box formats in the tokenized input.
 *
 * The function tests every pattern against each token and each adjacent pair.
 * One span can match several formats, as a five-digit number does.
 */
export function detectKnownFormats(text: string, tokens: ReadonlyArray<TokenClass>): KnownFormatHit[] {
	const hits: KnownFormatHit[] = []

	for (const tok of tokens) {
		for (const p of PATTERNS) {
			if (p.tokenSpan !== 1) continue

			if (p.pattern.test(tok.span.body)) {
				hits.push({ format: p.format, span: tok.span, confidence: p.confidence })
			}
		}
	}

	// Two-token patterns see the pair joined by a single space.
	for (let i = 0; i + 1 < tokens.length; i++) {
		const a = tokens[i]
		const b = tokens[i + 1]

		if (!a || !b) continue
		const joined = `${a.span.body} ${b.span.body}`

		for (const p of PATTERNS) {
			if (p.tokenSpan !== 2) continue

			if (p.pattern.test(joined)) {
				hits.push({
					format: p.format,
					span: { start: a.span.start, end: b.span.end, body: text.slice(a.span.start, b.span.end) },
					confidence: p.confidence,
				})
			}
		}
	}

	const poHit = detectPoBox(text, tokens)

	if (poHit) {
		hits.push(poHit)
	}

	return hits
}

function detectPoBox(text: string, tokens: ReadonlyArray<TokenClass>): KnownFormatHit | null {
	if (!tokens.length) return null

	// A PO box is a leader such as "PO" or "BP", optional further leaders such as "Box",
	// and then a numeric or alphanumeric box number.
	for (let i = 0; i < tokens.length; i++) {
		const leadTok = tokens[i]

		if (!leadTok) continue
		const lead = leadTok.span.body.toLowerCase()

		if (!PO_BOX_LEADERS.has(lead)) continue

		// The box number must appear within the next three tokens.
		let last = i
		let foundNumber = false

		for (let j = i + 1; j <= Math.min(i + 3, tokens.length - 1); j++) {
			const tj = tokens[j]

			if (!tj) break
			const tjBody = tj.span.body.toLowerCase()

			if (PO_BOX_LEADERS.has(tjBody)) {
				last = j

				continue
			}

			if (tj.class === "digit" || tj.class === "mixed") {
				last = j
				foundNumber = true

				break
			}

			break
		}

		if (foundNumber) {
			const startTok = tokens[i]
			const endTok = tokens[last]

			if (!startTok || !endTok) return null
			const start = startTok.span.start
			const end = endTok.span.end

			return {
				format: "po_box",
				span: { start, end, body: text.slice(start, end) },
				confidence: 0.85,
			}
		}
	}

	return null
}
