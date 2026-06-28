/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { KnownFormat, KnownFormatHit, TokenClass } from "./types.js"

/**
 * Universal postcode + PO-box patterns. Each entry is a regex that matches a token (or a small sequence of tokens
 * joined by a single space) and the format it represents.
 *
 * Bitter-lesson-safe boundary: this set grows ~1 pattern per new locale, not 50K dictionary entries.
 */
interface FormatPattern {
	format: KnownFormat
	/** Pattern matched against a single token's body, or against a 2-token joined body. */
	pattern: RegExp
	/** Tokens per match (1 or 2). */
	tokenSpan: 1 | 2
	/** Base confidence when no locale context. Ambiguous patterns score lower. */
	confidence: number
}

const PATTERNS: ReadonlyArray<FormatPattern> = [
	// Unambiguous single-token patterns first.
	{ format: "us_zip4", pattern: /^\d{5}-\d{4}$/, tokenSpan: 1, confidence: 0.95 },
	{ format: "ca_postcode", pattern: /^[A-Z]\d[A-Z]\d[A-Z]\d$/i, tokenSpan: 1, confidence: 0.95 },
	{ format: "jp_postcode", pattern: /^\d{3}-\d{4}$/, tokenSpan: 1, confidence: 0.95 },
	// UK postcode is 2 tokens when split on space (e.g. "SW1A 1AA"), 1 token otherwise.
	{ format: "uk_postcode", pattern: /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/i, tokenSpan: 1, confidence: 0.9 },
	{ format: "uk_postcode", pattern: /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/i, tokenSpan: 2, confidence: 0.9 },
	{ format: "ca_postcode", pattern: /^[A-Z]\d[A-Z] \d[A-Z]\d$/i, tokenSpan: 2, confidence: 0.9 },
	// Ambiguous 5-digit (US/FR/DE). Tag as us_zip with reduced confidence; caller disambiguates by
	// locale prior. Multiple format hits on the same span are possible.
	{ format: "us_zip", pattern: /^\d{5}$/, tokenSpan: 1, confidence: 0.6 },
	{ format: "fr_postcode", pattern: /^\d{5}$/, tokenSpan: 1, confidence: 0.6 },
	{ format: "de_postcode", pattern: /^\d{5}$/, tokenSpan: 1, confidence: 0.6 },
	// PO Box variants (US + FR). The pattern matches across 2-3 tokens — handled separately.
]

const PO_BOX_LEADERS = new Set(["po", "p.o.", "p.o", "box", "bp", "b.p.", "b.p", "casilla", "apartado"])

/**
 * Detect known-format hits among the tokenized input.
 *
 * Strategy: for each token (or adjacent pair), try every pattern. Multiple format hits on the same span are allowed
 * (US/FR/DE 5-digit ambiguity surfaces all three).
 */
export function detectKnownFormats(text: string, tokens: ReadonlyArray<TokenClass>): KnownFormatHit[] {
	const hits: KnownFormatHit[] = []

	// Single-token patterns.
	for (const tok of tokens) {
		for (const p of PATTERNS) {
			if (p.tokenSpan !== 1) continue

			if (p.pattern.test(tok.span.body)) {
				hits.push({ format: p.format, span: tok.span, confidence: p.confidence })
			}
		}
	}

	// Two-token patterns (joined by a single space).
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

	// PO Box detection — handled separately because the leader can be 1-3 tokens and the number
	// can be alphanumeric.
	const poHit = detectPoBox(text, tokens)

	if (poHit) hits.push(poHit)

	return hits
}

function detectPoBox(text: string, tokens: ReadonlyArray<TokenClass>): KnownFormatHit | null {
	if (tokens.length === 0) return null

	// Find a leader token + optional "Box" + numeric/alphanumeric.
	for (let i = 0; i < tokens.length; i++) {
		const leadTok = tokens[i]

		if (!leadTok) continue
		const lead = leadTok.span.body.toLowerCase()

		if (!PO_BOX_LEADERS.has(lead)) continue

		// Walk forward up to 3 tokens looking for the box number.
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

			// Numeric or alphanumeric token = the box number.
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
