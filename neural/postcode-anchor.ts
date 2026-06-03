/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode anchor — the first member of the "anchor-based parsing" family (Direction D, #240). See
 *   `docs/articles/plan/2026-06-03-anchor-based-parsing.md`.
 *
 *   A postcode is the most information-dense token in an address: a hierarchical geo-encoding that
 *   places a query on Earth far more cheaply than the rest of the parse. This module lifts the
 *   postcode out of the BIO sequence-labelling problem and treats it as a structured anchor. It
 *   runs the same per-country shape regexes the decoder repair pass uses ({@link collectMatches}),
 *   resolves each shaped span against a postcode gazetteer, and returns a SOFT signal: a country
 *   posterior plus a calibrated confidence. It never decides a postcode's identity on its own — it
 *   reports "this string is (or is not) a real postcode, in these countries, near here", and leaves
 *   the parser to weigh that against the surrounding tokens.
 *
 *   Two design rules carried from the DeepSeek consult
 *   (`.agents/skills/deepseek-consult/ds-pc-turn{1,2}-postcode-anchor.txt`):
 *
 *   - The country posterior is UNIFORM over the countries a string actually exists in. We never weight
 *       by per-country postcode volume, because that skews "75001" toward whichever country owns
 *       more 5-digit codes — the exact bias the anchor exists to avoid. Disambiguation is the
 *       parser's job, using script, city tokens, and user locale.
 *   - Confidence combines gazetteer MEMBERSHIP with country AMBIGUITY. A string that matches a postcode
 *       regex but exists in no gazetteer (a bare `27`, or a 5-digit house number that is not a real
 *       code) gets confidence 0, so the parser treats it as a house number. A real-but-ambiguous
 *       code (`75001` in FR and US) gets moderate confidence. A real, single-country code gets
 *       1.0.
 */

import { collectMatches } from "./postcode-repair.js"

/** A gazetteer hit for a postcode string. `lat`/`lon` of 0 means "known postcode, no centroid yet". */
export interface PostcodePlace {
	country: string
	lat: number
	lon: number
}

/**
 * The minimal surface the anchor needs from a gazetteer. Implementations: an in-memory fake (tests)
 * or a SQLite-backed lookup over the `postalcode-*.db` shards (`@mailwoman/resolver-wof-sqlite`).
 * Keeping the seam this narrow lets a future FST/WASM resolver drop in without touching the anchor
 * logic.
 */
export interface PostcodeResolver {
	/** Exact-match lookup of a normalized postcode string across every country shard. */
	lookup(postcode: string): PostcodePlace[]
}

export interface PostcodeAnchor {
	/** The shaped substring as it appeared in the raw text, with char offsets. */
	span: { text: string; start: number; end: number }
	/** The normalized form actually queried (uppercased, `D-` prefix stripped, whitespace collapsed). */
	normalized: string
	/** Coordinate-bearing gazetteer hits — best-effort centroid(s), one representative per country. */
	candidates: PostcodePlace[]
	/**
	 * Uniform distribution over the countries the postcode exists in (membership,
	 * coordinate-independent).
	 */
	posterior: Record<string, number>
	/** `1 - normalizedEntropy(posterior)` when the postcode exists; `0` when it is in no gazetteer. */
	confidence: number
}

/**
 * Entropy cap for the confidence formula: a k-way country split saturates toward 0 confidence at
 * k=10.
 */
const MAX_COUNTRIES = 10

/**
 * Normalize a shaped span to the canonical gazetteer key: uppercase, collapse internal whitespace
 * to a single space, and strip the German `D-` courtesy prefix (the shards store `68161`, not
 * `D-68161`).
 */
export function normalizePostcode(raw: string): string {
	let s = raw.trim().toUpperCase().replace(/\s+/g, " ")
	if (/^D-\d{5}$/.test(s)) s = s.slice(2)
	return s
}

/**
 * `1 - log2(k)/log2(MAX_COUNTRIES)`, clamped to [0, 1]. k=1 → 1.0; k=2 → ~0.70; k≥MAX_COUNTRIES →
 * 0.
 */
function confidenceFromCountryCount(k: number): number {
	if (k <= 0) return 0
	if (k === 1) return 1
	const c = 1 - Math.log2(k) / Math.log2(MAX_COUNTRIES)
	return Math.max(0, Math.min(1, c))
}

/**
 * Extract postcode anchors from raw text. For each postcode-shaped span, resolve it against the
 * gazetteer and emit a soft anchor (country posterior + confidence). Spans that match a shape but
 * exist in no gazetteer are still returned, with an empty posterior and confidence 0 — an explicit
 * "looks like a postcode, but isn't one" so the caller can see the extractor fired and chose not to
 * anchor.
 */
export function extractPostcodeAnchors(text: string, resolver: PostcodeResolver): PostcodeAnchor[] {
	const anchors: PostcodeAnchor[] = []

	for (const match of collectMatches(text)) {
		const spanText = text.slice(match.start, match.end)
		const normalized = normalizePostcode(spanText)
		const hits = resolver.lookup(normalized)

		// Membership: distinct countries the postcode exists in (regardless of whether we have a centroid).
		const countries = [...new Set(hits.map((h) => h.country))].sort()
		const k = countries.length

		const posterior: Record<string, number> = {}
		for (const c of countries) posterior[c] = 1 / k

		// Placement: one representative coordinate-bearing hit per country (the first with real coords).
		const candidates: PostcodePlace[] = []
		for (const c of countries) {
			const placed = hits.find((h) => h.country === c && h.lat !== 0 && h.lon !== 0)
			if (placed) candidates.push(placed)
		}

		anchors.push({
			span: { text: spanText, start: match.start, end: match.end },
			normalized,
			candidates,
			posterior,
			confidence: confidenceFromCountryCount(k),
		})
	}

	return anchors
}
