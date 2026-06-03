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

import { isGermanStreetToken } from "@mailwoman/codex/de"
import { isStreetSuffixToken, isUsStateAbbreviation } from "@mailwoman/codex/us"
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
	/**
	 * `exact` — the string is a real postcode; `fuzzy` — only an edit-distance-1 variant exists (a
	 * likely typo / OCR slip), so the confidence carries a penalty; `none` — in no gazetteer.
	 */
	matchType: "exact" | "fuzzy" | "none"
	/**
	 * Structural house-number prior in [0, 1]: `1` for a code that cannot be a house number, and
	 * below `1` for a digit-only code sharing its comma-delimited segment with a street word (so it
	 * reads as a house number rather than a postcode). Already folded into {@link confidence}; exposed
	 * so a consumer can rank competing spans, or see why one was down-weighted, without re-deriving
	 * it.
	 */
	positionFactor: number
}

export interface ExtractPostcodeAnchorsOpts {
	/**
	 * When an exact lookup finds nothing, retry Damerau–Levenshtein ≤1 variants to absorb typos and
	 * OCR slips (`75OO8` → `75008`). Off by default so existing callers keep exact-match behaviour.
	 */
	fuzzy?: boolean
}

/**
 * Entropy cap for the confidence formula: a k-way country split saturates toward 0 confidence at
 * k=10.
 */
const MAX_COUNTRIES = 10

/** A fuzzy (typo-corrected) match is less certain than an exact one — scale its confidence down. */
const FUZZY_PENALTY = 0.6

/**
 * Class-aware edit-distance-1 variants of a postcode string: deletions, same-class substitutions
 * (digit↔digit, letter↔letter), same-class insertions, and adjacent transpositions. Restricting
 * substitutions/insertions to the character's class mirrors how humans mistype or OCR a postcode (a
 * digit becomes another digit, not a letter) and keeps the candidate set small.
 */
export function editDistance1Variants(s: string): string[] {
	const classOf = (ch: string): string =>
		/[0-9]/.test(ch) ? "0123456789" : /[A-Z]/.test(ch) ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : ""
	const variants = new Set<string>()
	for (let i = 0; i < s.length; i++) variants.add(s.slice(0, i) + s.slice(i + 1)) // deletions
	for (let i = 0; i < s.length; i++) {
		for (const c of classOf(s[i]!)) if (c !== s[i]) variants.add(s.slice(0, i) + c + s.slice(i + 1)) // substitutions
	}
	for (let i = 0; i <= s.length; i++) {
		for (const c of classOf(s[i] ?? s[i - 1] ?? "")) variants.add(s.slice(0, i) + c + s.slice(i)) // insertions
	}
	for (let i = 0; i + 1 < s.length; i++) variants.add(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2)) // transpositions
	variants.delete(s)
	return [...variants]
}

/**
 * Normalize a shaped span to the canonical gazetteer key: uppercase, collapse internal whitespace
 * to a single space, and strip the German `D-` courtesy prefix (the shards store `68161`, not
 * `D-68161`).
 */
export function normalizePostcode(raw: string): string {
	let s = raw.trim().toUpperCase().replace(/\s+/g, " ")
	if (/^D-\d{5}$/.test(s)) s = s.slice(2) // German courtesy prefix: D-68161 → 68161
	if (/^\d{4} [A-Z]{2}$/.test(s)) s = s.replace(" ", "") // Dutch: gazetteer stores 1012LM, not 1012 LM
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
 * Confidence scale for a digit-only code that shares its segment with a street word. A house number
 * and a 5-digit postcode are the same shape, so membership alone can't separate `12345 Main St`
 * (house number that happens to be a real ZIP elsewhere) from `San Francisco 94105` (postcode). The
 * structural tell is cheap and locale-general: house numbers sit beside the street, postcodes
 * beside the city. We scale rather than zero — the gazetteer still vouches for the shape, so a lone
 * code in a street-only line stays usable; the penalty just lets a real trailing postcode out-rank
 * it.
 */
const HOUSE_NUMBER_PENALTY = 0.2

/**
 * Standalone street-type words for locales that write the type as its own word (FR/ES/IT). US comes
 * from `@mailwoman/codex/us` and German from `@mailwoman/codex/de`; the Dutch compound suffixes are
 * still inline below until a `codex/nl` slice exists.
 */
const NON_US_STREET_WORDS = new Set([
	// French
	"rue",
	"bd",
	"impasse",
	"chemin",
	"quai",
	"allée",
	"allee",
	"cours",
	"passage",
	// Spanish
	"calle",
	"avenida",
	"avda",
	"plaza",
	"paseo",
	"camino",
	"carrera",
	"ronda",
	// Italian
	"via",
	"viale",
	"piazza",
	"corso",
	"largo",
	"vicolo",
	"strada",
	"contrada",
])

/** Dutch compound street suffixes — matched against a token's tail (pending a `codex/nl` slice). */
const NL_STREET_SUFFIXES = ["straat", "laan", "plein", "gracht", "kade", "dijk", "steeg", "dreef"]

/**
 * True when a token denotes a street. US suffixes come from the USPS Pub-28 table in
 * `@mailwoman/codex/us` (complete, so `Trl`/`Holw`/`Xing` all match), EXCEPT the abbreviations that
 * collide with a state code — `KY` (Key vs Kentucky), `PR` (Prairie vs Puerto Rico) — which sit in
 * the postcode's own `City, ST ZIP` segment. German compounds come from `@mailwoman/codex/de`
 * ({@link isGermanStreetToken}), whose suffix set already excludes the place-name endings (`-berg`,
 * `-burg`, `-dorf`) that would otherwise flag a city token. FR/ES/IT and Dutch fall back to the
 * inline lists.
 *
 * Suffix vocabularies collide across locales (German `-ring` matches English `spring`). That stays
 * harmless because the caller only tests tokens inside the postcode's OWN comma-segment, which
 * holds the city/state, not a street — and a misfire only scales confidence, which the consumer's
 * floor absorbs. A locale-conditioned check is the cleaner long-term fix once the anchor carries a
 * locale.
 */
function looksLikeStreetWord(token: string): boolean {
	const t = token.toLowerCase().replace(/[^\p{L}]/gu, "")
	if (t.length < 2) return false
	if (isStreetSuffixToken(t) && !isUsStateAbbreviation(t)) return true
	if (isGermanStreetToken(t)) return true
	if (NON_US_STREET_WORDS.has(t)) return true
	return NL_STREET_SUFFIXES.some((s) => t.length > s.length && t.endsWith(s))
}

/**
 * Position-aware confidence factor for a postcode span: `1` for anything that cannot be confused
 * with a house number, and {@link HOUSE_NUMBER_PENALTY} for a digit-only code sharing its
 * comma-delimited segment with a street word. This is the structural prior that lets the anchor
 * tell a leading `12345 Main St` house number from a trailing `San Francisco 94105` postcode with
 * no model in the loop — and lets a consumer pick the right span by confidence instead of by raw
 * position.
 */
function positionFactor(text: string, start: number, normalized: string): number {
	if (!/^\d+$/.test(normalized)) return 1 // only digit-only codes collide with house numbers
	const segStart = text.lastIndexOf(",", start - 1) + 1
	let segEnd = text.indexOf(",", start)
	if (segEnd < 0) segEnd = text.length
	for (const token of text.slice(segStart, segEnd).split(/\s+/)) {
		if (looksLikeStreetWord(token)) return HOUSE_NUMBER_PENALTY
	}
	return 1
}

/**
 * Extract postcode anchors from raw text. For each postcode-shaped span, resolve it against the
 * gazetteer and emit a soft anchor (country posterior + confidence). Spans that match a shape but
 * exist in no gazetteer are still returned, with an empty posterior and confidence 0 — an explicit
 * "looks like a postcode, but isn't one" so the caller can see the extractor fired and chose not to
 * anchor.
 */
export function extractPostcodeAnchors(
	text: string,
	resolver: PostcodeResolver,
	opts: ExtractPostcodeAnchorsOpts = {}
): PostcodeAnchor[] {
	const anchors: PostcodeAnchor[] = []

	for (const match of collectMatches(text)) {
		const spanText = text.slice(match.start, match.end)
		const normalized = normalizePostcode(spanText)

		// Exact first; fall back to edit-distance-1 variants only when exact finds nothing.
		let hits = resolver.lookup(normalized)
		let matchType: PostcodeAnchor["matchType"] = hits.length > 0 ? "exact" : "none"
		if (matchType === "none" && opts.fuzzy) {
			const fuzzyHits: PostcodePlace[] = []
			for (const variant of editDistance1Variants(normalized)) {
				for (const h of resolver.lookup(variant)) fuzzyHits.push(h)
			}
			if (fuzzyHits.length > 0) {
				hits = fuzzyHits
				matchType = "fuzzy"
			}
		}

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

		const position = positionFactor(text, match.start, normalized)
		const confidence = confidenceFromCountryCount(k) * (matchType === "fuzzy" ? FUZZY_PENALTY : 1) * position

		anchors.push({
			span: { text: spanText, start: match.start, end: match.end },
			normalized,
			candidates,
			posterior,
			confidence,
			matchType,
			positionFactor: position,
		})
	}

	return anchors
}
