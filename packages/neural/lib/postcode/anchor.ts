/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { candidateSystemsForPostcode } from "@mailwoman/codex"
import { isGermanStreetToken } from "@mailwoman/codex/de"
import { isFrenchStreetWord } from "@mailwoman/codex/fr"
import { isStreetSuffixToken, isUSStateAbbreviation } from "@mailwoman/codex/us"

import { collectMatches } from "#postcode/repair"

/**
 * One gazetteer hit for a postcode.
 *
 * A `lat` and `lon` of 0 mean the postcode is known but has no centroid.
 */
export interface PostcodePlace {
	country: string
	lat: number
	lon: number
}

/**
 * The postcode lookup that the anchor extractor needs from a gazetteer.
 */
export interface PostcodeResolver {
	/**
	 * Returns every exact match for a normalized postcode across all country extracts.
	 */
	lookup(postcode: string): PostcodePlace[]
}

/**
 * A postcode-shaped span in the input and the country evidence it provides.
 */
export interface PostcodeAnchor {
	/**
	 * The matched substring of the raw text and its character offsets.
	 */
	span: { text: string; start: number; end: number }

	/**
	 * The lookup key produced by {@link normalizePostcode}.
	 */
	normalized: string

	/**
	 * One hit with a centroid per matched country.
	 * Countries whose hits all lack a centroid are omitted.
	 */
	candidates: PostcodePlace[]

	/**
	 * A uniform probability over the countries whose gazetteer contains the postcode.
	 */
	posterior: Record<string, number>

	/**
	 * The anchor strength in [0, 1].
	 *
	 * It equals `1 - log2(k) / log2(10)` for `k` matched countries, multiplied by
	 * the fuzzy penalty and `positionFactor`.
	 * It is `0` when no gazetteer contains the postcode.
	 */
	confidence: number

	/**
	 * How the span matched.
	 *
	 * `outward` means a GB unit postcode matched its outward code without penalty.
	 * `fuzzy` means only an edit-distance-1 variant matched, and the confidence is penalized.
	 */
	matchType: "exact" | "outward" | "fuzzy" | "none"

	/**
	 * The house-number factor included in `confidence`.
	 *
	 * It is `0.2` for a digit-only code that shares its comma-delimited segment
	 * with a street word, and `1` otherwise.
	 */
	positionFactor: number
}

/**
 * Options for {@link extractPostcodeAnchors}.
 */
export interface ExtractPostcodeAnchorsOpts {
	/**
	 * Whether to retry an unmatched span with its {@link editDistance1Variants} at reduced confidence.
	 * It defaults to false.
	 */
	fuzzy?: boolean
}

const MAX_COUNTRIES = 10

const FUZZY_PENALTY = 0.6

/**
 * Returns the edit-distance-1 variants of a postcode.
 *
 * The variants are deletions, adjacent transpositions, and substitutions and insertions
 * within the neighbouring character's class (digit or letter).
 * Restricting the class keeps the candidate set small.
 */
export function editDistance1Variants(s: string): string[] {
	const classOf = (ch: string): string =>
		/[0-9]/.test(ch) ? "0123456789" : /[A-Z]/.test(ch) ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : ""

	const variants = new Set<string>()

	for (let i = 0; i < s.length; i++) {
		variants.add(s.slice(0, i) + s.slice(i + 1))
	}

	for (let i = 0; i < s.length; i++) {
		for (const c of classOf(s[i]!))
			if (c !== s[i]) {
				variants.add(s.slice(0, i) + c + s.slice(i + 1))
			}
	}

	for (let i = 0; i <= s.length; i++) {
		for (const c of classOf(s[i] ?? s[i - 1] ?? "")) {
			variants.add(s.slice(0, i) + c + s.slice(i))
		}
	}

	for (let i = 0; i + 1 < s.length; i++) {
		variants.add(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2))
	}

	variants.delete(s)

	return [...variants]
}

/**
 * Normalizes a postcode-shaped span to the gazetteer key form.
 *
 * It uppercases, collapses whitespace, drops the German `D-` prefix and removes the
 * space in Dutch `1234 AB` codes, matching how the extracts store postcodes.
 */
export function normalizePostcode(raw: string): string {
	let s = raw.trim().toUpperCase().replaceAll(/\s+/g, " ")

	if (/^D-\d{5}$/.test(s)) {
		s = s.slice(2)
	}

	if (/^\d{4} [A-Z]{2}$/.test(s)) {
		s = s.replace(" ", "")
	}

	return s
}

/**
 * Returns the outward code of a normalized GB unit postcode, or `null` for any other string.
 *
 * For example, `SO4 3RX` becomes `SO4`.
 * The GB gazetteer holds only outward codes, so the extractor retries with the
 * outward code when a full unit postcode misses.
 */
export function gbOutwardCode(normalized: string): string | null {
	const sp = normalized.indexOf(" ")

	if (sp < 1) return null

	return /^\d[A-Z]{2}$/.test(normalized.slice(sp + 1)) ? normalized.slice(0, sp) : null
}

function confidenceFromCountryCount(k: number): number {
	if (k <= 0) return 0

	if (k === 1) return 1
	const c = 1 - Math.log2(k) / Math.log2(MAX_COUNTRIES)

	return Math.max(0, Math.min(1, c))
}

const HOUSE_NUMBER_PENALTY = 0.2

const NON_US_STREET_WORDS = new Set([
	"calle",
	"avenida",
	"avda",
	"plaza",
	"paseo",
	"camino",
	"carrera",
	"ronda",

	"via",
	"viale",
	"piazza",
	"corso",
	"largo",
	"vicolo",
	"strada",
	"contrada",
])

const NL_STREET_SUFFIXES = ["straat", "laan", "plein", "gracht", "kade", "dijk", "steeg", "dreef"]

function looksLikeStreetWord(token: string, systems: ReadonlySet<string>): boolean {
	const t = token.toLowerCase().replaceAll(/[^\p{L}]/gu, "")

	if (t.length < 2) return false

	if (systems.has("us") && isStreetSuffixToken(t) && !isUSStateAbbreviation(t)) return true

	if (systems.has("de") && isGermanStreetToken(t)) return true

	if (systems.has("fr") && isFrenchStreetWord(t)) return true

	if ((systems.has("es") || systems.has("it")) && NON_US_STREET_WORDS.has(t)) return true

	if (systems.has("nl")) return NL_STREET_SUFFIXES.some((s) => t.length > s.length && t.endsWith(s))

	return false
}

function positionFactor(text: string, start: number, normalized: string, systems: ReadonlySet<string>): number {
	if (!/^\d+$/.test(normalized)) return 1
	const segStart = text.lastIndexOf(",", start - 1) + 1
	let segEnd = text.indexOf(",", start)

	if (segEnd < 0) {
		segEnd = text.length
	}

	for (const token of text.slice(segStart, segEnd).split(/\s+/)) {
		if (looksLikeStreetWord(token, systems)) return HOUSE_NUMBER_PENALTY
	}

	return 1
}

/**
 * Looks up each postcode-shaped span in the gazetteer and returns its country anchor.
 *
 * A span that no gazetteer contains is still returned, with an empty posterior and a confidence of 0.
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

		let hits = resolver.lookup(normalized)
		let matchType: PostcodeAnchor["matchType"] = hits.length ? "exact" : "none"

		if (matchType === "none") {
			const outward = gbOutwardCode(normalized)

			if (outward) {
				const outwardHits = resolver.lookup(outward)

				if (outwardHits.length) {
					hits = outwardHits
					matchType = "outward"
				}
			}
		}

		if (matchType === "none" && opts.fuzzy) {
			const fuzzyHits: PostcodePlace[] = []

			for (const variant of editDistance1Variants(normalized)) {
				for (const h of resolver.lookup(variant)) {
					fuzzyHits.push(h)
				}
			}

			if (fuzzyHits.length) {
				hits = fuzzyHits
				matchType = "fuzzy"
			}
		}

		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
		const countries = [...new Set(hits.map((h) => h.country))].sort()
		const k = countries.length

		const posterior: Record<string, number> = {}

		for (const c of countries) {
			posterior[c] = 1 / k
		}

		const candidates: PostcodePlace[] = []

		for (const c of countries) {
			const placed = hits.find((h) => h.country === c && h.lat !== 0 && h.lon !== 0)

			if (placed) {
				candidates.push(placed)
			}
		}

		const systems = countries.length
			? new Set(countries.map((c) => c.toLowerCase()))
			: new Set<string>(candidateSystemsForPostcode(normalized))

		const position = positionFactor(text, match.start, normalized, systems)
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
