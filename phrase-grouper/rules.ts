/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rule-based scorers for Stage 2.7 phrase grouping. Each rule inspects the tokenized segment +
 *   QueryShape priors and emits zero or more `PhraseProposal`s with a confidence in [0, 1].
 *
 *   Bitter-lesson-safe: only universal structural cues (proximity, punctuation, capitalization,
 *   hyphenation, format-shape repetition). No place-name dictionaries — a `LOCALITY_PHRASE`
 *   proposal means "this looks shaped like a multi-word capitalized run that COULD be a city name",
 *   not "this IS a city name". Typing the span is the classifier's job; this layer only answers "do
 *   these tokens belong together?".
 *
 *   Per "possibilities not constraints", rules emit overlapping proposals freely. The reconciler
 *   (Stage 5) picks the best non-overlapping subset.
 */

import { Span } from "@mailwoman/core/tokenization"
import type { PhraseProposal, QueryShapeLike } from "./types.js"

/**
 * One token within a segment — absolute offsets into the normalized input. Built by
 * `tokenizeSegment` from a (segment-text, segment-start) pair.
 */
export interface SegmentToken {
	body: string
	start: number
	end: number
}

const WHITESPACE = /\s+/

const US_REGION_NAMES: ReadonlySet<string> = new Set([
	"alabama",
	"alaska",
	"arizona",
	"arkansas",
	"california",
	"colorado",
	"connecticut",
	"delaware",
	"florida",
	"georgia",
	"hawaii",
	"idaho",
	"illinois",
	"indiana",
	"iowa",
	"kansas",
	"kentucky",
	"louisiana",
	"maine",
	"maryland",
	"massachusetts",
	"michigan",
	"minnesota",
	"mississippi",
	"missouri",
	"montana",
	"nebraska",
	"nevada",
	"ohio",
	"oklahoma",
	"oregon",
	"pennsylvania",
	"tennessee",
	"texas",
	"utah",
	"vermont",
	"virginia",
	"washington",
	"wisconsin",
	"wyoming",
])

/**
 * Split a segment body into whitespace-separated tokens. Offsets are absolute into the original
 * input (caller supplies the segment's `start` offset).
 */
export function tokenizeSegment(segmentBody: string, segmentStart: number): SegmentToken[] {
	const tokens: SegmentToken[] = []
	let i = 0
	while (i < segmentBody.length) {
		while (i < segmentBody.length && WHITESPACE.test(segmentBody[i]!)) i++
		if (i >= segmentBody.length) break
		const start = i
		while (i < segmentBody.length && !WHITESPACE.test(segmentBody[i]!)) i++
		tokens.push({
			body: segmentBody.slice(start, i),
			start: segmentStart + start,
			end: segmentStart + i,
		})
	}
	return tokens
}

/** Build a `Section` (Span instance) from absolute offsets into the original text. */
function makeSection(text: string, start: number, end: number): Span {
	return Span.from(text.slice(start, end), { start })
}

/** True when token body is non-empty digits only. */
function isAllDigit(s: string): boolean {
	return s.length > 0 && /^[0-9]+$/.test(s)
}

/** True when token body is 2-3 uppercase Latin letters (US state, Canadian province abbreviation). */
function isRegionAbbreviation(s: string): boolean {
	return /^[A-Z]{2,3}$/.test(s)
}

/**
 * True when token starts with an uppercase letter — the common Western proper-noun shape.
 * Unicode-aware (`\p{Lu}`) so accented Latin capitals (`Évellys`, `Étagnac`, `Ñuñoa`, `Ávila`)
 * count as proper nouns too; an ASCII-only `[A-Z]` silently dropped those localities from the
 * grouper (#425 residual).
 */
function startsCapitalized(s: string): boolean {
	return /^\p{Lu}/u.test(s)
}

/**
 * Common street-type suffixes (en-US + en-GB + abbreviated forms). Match case-insensitively against
 * the raw token body. The set is intentionally short — coverage extension belongs in a future
 * per-locale rule pack, not as a 500-entry dictionary in this rule.
 */
const STREET_SUFFIXES: ReadonlySet<string> = new Set([
	"st",
	"st.",
	"street",
	"ave",
	"ave.",
	"avenue",
	"blvd",
	"blvd.",
	"boulevard",
	"rd",
	"rd.",
	"road",
	"ln",
	"ln.",
	"lane",
	"dr",
	"dr.",
	"drive",
	"way",
	"pl",
	"pl.",
	"place",
	"ct",
	"ct.",
	"court",
	"pkwy",
	"parkway",
	"hwy",
	"highway",
	"ter",
	"terrace",
	"cir",
	"circle",
	"sq",
	"square",
	"trl",
	"trail",
])

function isStreetSuffix(token: string): boolean {
	return STREET_SUFFIXES.has(token.toLowerCase())
}

/**
 * Romance/Latin street-TYPE words that LEAD the street ("Via Trento", "Calle Mayor", "Corso
 * Italia"). English puts the type last (a suffix — see STREET_SUFFIXES); Romance languages put it
 * first. Without this, a leading "Via"/"Calle" is capitalized first-segment text the locality rule
 * happily proposes, and on OOD intl input the model can't type it either — so the grouper-audit
 * promotes it to a spurious `locality`, burying the real city (#425 re-gate).
 *
 * Street-TYPES only — deliberately NOT the ambiguous area/development words ("Polígono",
 * "Urbanización", "Lugar", "Partida", "Borgo") that legitimately serve AS localities. This stays a
 * bounded linguistic category; per-locale breadth belongs in a future rule pack, not an exception
 * pile.
 */
const STREET_PREFIXES: ReadonlySet<string> = new Set([
	// Italian
	"via",
	"viale",
	"corso",
	"largo",
	"vicolo",
	"strada",
	"piazza",
	"piazzale",
	"contrada",
	"traversa",
	"lungomare",
	// Spanish / Catalan
	"calle",
	"avenida",
	"avinguda",
	"carrer",
	"plaza",
	"plaça",
	"paseo",
	"passeig",
	"camino",
	"carretera",
	"ronda",
	"travesía",
	// Portuguese
	"rua",
	"travessa",
	"praça",
	// French
	"rue",
	"avenue",
	"boulevard",
	"chemin",
	"impasse",
	"allée",
	"quai",
])

function isStreetPrefix(token: string): boolean {
	return STREET_PREFIXES.has(token.toLowerCase())
}

/**
 * Lowercase connective particles that live INSIDE multi-word place names — the Romance/Germanic
 * glue that bridges two capitalized content words: "Las Palmas **de** Gran Canaria", "San Pietro
 * **in** Casale", "Alphen **aan den** Rijn", "Frankfurt **am** Main", "Rothenburg **ob der**
 * Tauber". This is a BOUNDED linguistic category (place-name connectives), not a gazetteer or a
 * stopword dump — and it only ever fires when bracketed by capitalized content on BOTH sides (see
 * `scoreLocalityPhrase`), so a stray "and"/"the" in a street phrase can't smuggle a particle
 * through. Keep coverage to the connectives that actually bridge place-name tokens; growing it into
 * a per-locale stopword list is the wrong move — that pressure belongs on the gazetteer/reconciler,
 * not here.
 */
const PLACE_NAME_PARTICLES: ReadonlySet<string> = new Set([
	// Spanish / Catalan / Portuguese
	"de",
	"del",
	"la",
	"las",
	"los",
	"el",
	"i",
	// Italian
	"di",
	"della",
	"dei",
	"degli",
	"delle",
	"in",
	"a",
	"sul",
	"sulla",
	// French
	"du",
	"des",
	"le",
	"les",
	"sur",
	"sous",
	"en",
	"lès",
	// Dutch / Flemish
	"aan",
	"op",
	"den",
	"ter",
	"ten",
	// German
	"am",
	"an",
	"auf",
	"ob",
	"im",
	"vor",
	"bei",
	"der",
])

/**
 * A short lowercase particle fused via apostrophe to a capitalized name — the Italian/French
 * elision that the tokenizer keeps as ONE token: `nell'Emilia`, `dell'Adda`, `l'Aquila`. Treated as
 * place-name CONTENT (it carries the proper noun), so it can both start and continue a locality
 * run.
 */
function isFusedParticleName(s: string): boolean {
	return /^\p{Ll}{1,6}['’]\p{Lu}/u.test(s)
}

/** Place-name content token: a capitalized word OR an apostrophe-fused particle name
(`nell'Emilia`). */
function isPlaceNameContent(s: string): boolean {
	return startsCapitalized(s) || isFusedParticleName(s)
}

/** True when the token is a known lowercase place-name connective (`de`, `in`, `aan`, `am`, …). */
function isPlaceNameParticle(s: string): boolean {
	return PLACE_NAME_PARTICLES.has(s.toLowerCase())
}

/**
 * Venue-marker nouns with per-term confidence weights. Same caveat as STREET_SUFFIXES — universal
 * structural markers, not a places dictionary. Higher weight = stronger venue signal.
 */
const VENUE_MARKERS: ReadonlyMap<string, number> = new Map([
	// Dining (0.90 — unambiguous venue markers)
	["steakhouse", 0.9],
	["restaurant", 0.9],
	["bistro", 0.9],
	["diner", 0.85],
	["cafe", 0.85],
	["café", 0.85],
	["grill", 0.8],
	["pizzeria", 0.9],
	["bakery", 0.85],
	["brewery", 0.85],
	["winery", 0.85],
	["tavern", 0.8],
	["pub", 0.75],
	["bar", 0.7],
	// Lodging
	["hotel", 0.9],
	["motel", 0.9],
	["inn", 0.75],
	["resort", 0.85],
	["lodge", 0.75],
	["hostel", 0.85],
	// Entertainment / culture
	["theater", 0.85],
	["theatre", 0.85],
	["cinema", 0.85],
	["stadium", 0.9],
	["arena", 0.85],
	["museum", 0.85],
	["gallery", 0.75],
	["casino", 0.85],
	["lounge", 0.7],
	// Retail / commercial
	["market", 0.7],
	["mall", 0.8],
	["plaza", 0.7],
	["tower", 0.65],
	["center", 0.6],
	["centre", 0.6],
	// Medical / institutional
	["hospital", 0.9],
	["clinic", 0.85],
	["pharmacy", 0.85],
	// Education
	["university", 0.9],
	["college", 0.85],
	["school", 0.8],
	["academy", 0.8],
	// Civic / religious
	["church", 0.8],
	["temple", 0.8],
	["mosque", 0.8],
	["synagogue", 0.85],
	["cathedral", 0.85],
	["chapel", 0.75],
	["library", 0.85],
	// Outdoor
	["park", 0.6],
	["gardens", 0.65],
	["ranch", 0.7],
	["farm", 0.65],
])

/**
 * Unit-designator tokens that gate the venue-by-exclusion heuristic. When any token in a segment
 * matches one of these, the segment is likely a unit/suite line, not a venue name.
 */
const UNIT_MARKERS: ReadonlySet<string> = new Set([
	"apt",
	"apt.",
	"apartment",
	"unit",
	"ste",
	"ste.",
	"suite",
	"room",
	"rm",
	"rm.",
	"floor",
	"fl",
	"fl.",
	"bldg",
	"bldg.",
	"building",
	"dept",
	"dept.",
	"department",
	"#",
])

function venueMarkerWeight(tokens: ReadonlyArray<SegmentToken>): number {
	let maxWeight = 0
	for (const t of tokens) {
		const w = VENUE_MARKERS.get(t.body.toLowerCase())
		if (w !== undefined && w > maxWeight) maxWeight = w
	}
	return maxWeight
}

function hasUnitMarker(tokens: ReadonlyArray<SegmentToken>): boolean {
	return tokens.some((t) => UNIT_MARKERS.has(t.body.toLowerCase()))
}

/**
 * `NUMERIC` rule: emit one proposal per all-digit token. House numbers, postcodes (when no format
 * hit), unit numbers all surface here as a base hypothesis.
 *
 * Confidence drops for very long runs (5+ digits) where POSTCODE will typically win; the reconciler
 * does the final pick.
 */
export function scoreNumeric(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (const t of tokens) {
		if (!isAllDigit(t.body)) continue
		const len = t.body.length
		// 1-4 digit pure-numerics are clearly NUMERIC (house number). 5+ are ambiguous with POSTCODE
		// — emit anyway at lower confidence so the reconciler sees both options.
		const confidence = len <= 4 ? 0.95 : 0.55
		out.push({
			span: makeSection(text, t.start, t.end),
			kindHypothesis: "NUMERIC",
			confidence,
		})
	}
	return out
}

/**
 * `POSTCODE` rule: lift each `QueryShape.knownFormats` postcode hit directly. The QueryShape stage
 * already did the format-shape recognition — Stage 2.7's job is just to publish the spans as phrase
 * proposals so the reconciler can use them.
 */
export function scorePostcode(shape: QueryShapeLike, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (const hit of shape.knownFormats) {
		// `po_box` is not a postcode; the kind classifier owns that signal. Skip non-postcode
		// formats here so we don't pollute POSTCODE proposals.
		if (hit.format === "po_box") continue
		out.push({
			span: makeSection(text, hit.span.start, hit.span.end),
			kindHypothesis: "POSTCODE",
			// Lift the format-hit confidence directly — Stage 5 can weight it against alternatives.
			confidence: hit.confidence,
		})
	}
	return out
}

/**
 * `REGION_ABBREVIATION` rule: 2-3 uppercase Latin letters. Tail-of-segment position boosts
 * confidence because that's the canonical "City, ST ZIP" shape.
 */
export function scoreRegionAbbreviation(
	tokens: ReadonlyArray<SegmentToken>,
	text: string,
	segmentIsLast: boolean
): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!
		if (!isRegionAbbreviation(t.body)) continue
		// A region code is canonically standalone — the tail of "City, ST ZIP", never immediately
		// followed by another place-name word. When the next token IS place-name content (and not
		// itself a region abbreviation or a street suffix), this token is the HEAD of a multi-word
		// place name ("SAN" NAZARIO, "DI" CASTELLO — common in all-caps intl data where every short
		// word matches the 2-3-uppercase shape), not a region. Suppressing the region proposal here
		// keeps it from out-deduping the same span's LOCALITY_PHRASE in the reconciler (#425).
		const after = tokens[i + 1]
		if (after && isPlaceNameContent(after.body) && !isRegionAbbreviation(after.body) && !isStreetSuffix(after.body)) {
			continue
		}
		// Position cue: last token in a segment (canonical region slot) → high confidence. Anywhere
		// else, moderate. Anywhere in the LAST segment → slightly elevated (region is canonically the
		// final non-postcode component).
		const atTail = i === tokens.length - 1
		const confidence = atTail ? 0.85 : segmentIsLast ? 0.7 : 0.55
		out.push({
			span: makeSection(text, t.start, t.end),
			kindHypothesis: "REGION_ABBREVIATION",
			confidence,
		})
	}
	return out
}

/**
 * `HYPHENATED_COMPOUND` rule: tokens containing an internal hyphen. Captures `NY-NY` (venue
 * disambiguation case), `Saint-Denis` (French locality compound), `10118-1234` (ZIP+4 written as a
 * single token).
 *
 * Internal hyphen is the cue; the rule doesn't pre-judge what the compound MEANS — that's typing
 * (classifier) or reconcile work. A high confidence here just says "this is one unit, not two".
 */
export function scoreHyphenatedCompound(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (const t of tokens) {
		if (!t.body.includes("-")) continue
		// Skip leading/trailing hyphens (likely punctuation drift) — require an interior hyphen
		// surrounded by non-hyphen characters.
		if (!/[^-]-[^-]/.test(t.body)) continue
		out.push({
			span: makeSection(text, t.start, t.end),
			kindHypothesis: "HYPHENATED_COMPOUND",
			confidence: 0.88,
		})
	}
	return out
}

/**
 * `STREET_PHRASE` rule: a token run that contains a street-type suffix. The span covers a leading
 * numeric (house number) when present, through the suffix token.
 *
 * Confidence reflects how canonical the run looks: NUMERIC + 1-3 capitalized words + SUFFIX scores
 * highest; suffix-only or non-leading-numeric variants score lower but still emit.
 */
export function scoreStreetPhrase(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (let suffixIdx = 0; suffixIdx < tokens.length; suffixIdx++) {
		if (!isStreetSuffix(tokens[suffixIdx]!.body)) continue
		// Walk left from the suffix gathering capitalized/numeric/ordinal tokens. Stop when we hit
		// something un-street-y (lowercase non-suffix, another suffix, etc.).
		let start = suffixIdx
		for (let i = suffixIdx - 1; i >= 0; i--) {
			const body = tokens[i]!.body
			if (isAllDigit(body) || /^\d+(st|nd|rd|th)$/i.test(body) || startsCapitalized(body)) {
				start = i
			} else {
				break
			}
		}
		// Need at least one preceding token (or a numeric house number) for STREET_PHRASE — a
		// suffix-only token "Street" alone isn't a street phrase.
		if (start === suffixIdx) continue
		const startTok = tokens[start]!
		const endTok = tokens[suffixIdx]!
		const hasLeadingNumeric = isAllDigit(startTok.body) || /^\d+(st|nd|rd|th)$/i.test(startTok.body)
		// Canonical NUMERIC + capitalized + SUFFIX scores high; capitalized-run + SUFFIX scores
		// slightly lower since it could also be a venue.
		const confidence = hasLeadingNumeric ? 0.9 : 0.75
		out.push({
			span: makeSection(text, startTok.start, endTok.end),
			kindHypothesis: "STREET_PHRASE",
			confidence,
		})
	}
	// Romance street pattern: the street TYPE LEADS ("Via Trento", "Calle Mayor", "Largo Millefiori").
	// Walk RIGHT from a street-prefix token gathering capitalized place-name words (bridging particles),
	// stopping at a digit house-number or any non-place token.
	for (let prefixIdx = 0; prefixIdx < tokens.length; prefixIdx++) {
		if (!isStreetPrefix(tokens[prefixIdx]!.body)) continue
		let end = prefixIdx
		for (let i = prefixIdx + 1; i < tokens.length; i++) {
			const body = tokens[i]!.body
			if (isStreetPrefix(body)) break
			if (isPlaceNameContent(body) || isPlaceNameParticle(body)) {
				end = i
			} else {
				break
			}
		}
		// Don't end on a trailing connective particle ("Calle de" is not a street name).
		while (end > prefixIdx && isPlaceNameParticle(tokens[end]!.body)) end--
		const startTok = tokens[prefixIdx]!
		const endTok = tokens[end]!
		// Prefix + name scores moderately; a bare prefix still emits a low-confidence marker so the
		// audit types the leftover span `street`, never `locality`.
		out.push({
			span: makeSection(text, startTok.start, endTok.end),
			kindHypothesis: "STREET_PHRASE",
			confidence: end > prefixIdx ? 0.72 : 0.5,
		})
	}
	return out
}

/**
 * `LOCALITY_PHRASE` rule: runs of contiguous place-name tokens (1-6 long). Emits multiple
 * overlapping proposals so the reconciler can choose between e.g. `Saint Petersburg` as one phrase
 * vs `Saint` + `Petersburg` as two.
 *
 * The run bridges lowercase place-name PARTICLES (`de`, `in`, `aan den`, `am`, …) and
 * apostrophe-fused names (`nell'Emilia`) when they sit between capitalized content — without that,
 * the walk used to stop dead at the first lowercase token, so it never proposed "Reggio
 * nell'Emilia", "Las Palmas de Gran Canaria", or "San Pietro in Casale" as single spans. Those gaps
 * are exactly the native-order multi-word localities the joint-decode A/B fragmented (Route A Phase
 * I, #425).
 *
 * Confidence scales with: run length (2-5 are good place-name lengths), tail-of-segment position,
 * and whether the span sits at a segment boundary.
 */
export function scoreLocalityPhrase(
	tokens: ReadonlyArray<SegmentToken>,
	text: string,
	segmentIsLast: boolean
): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (let i = 0; i < tokens.length; i++) {
		if (!isPlaceNameContent(tokens[i]!.body)) continue
		// A leading street-type word ("Via", "Calle", "Corso") heads a STREET, not a locality — let
		// scoreStreetPhrase own it so the audit never promotes it to a spurious locality.
		if (isStreetPrefix(tokens[i]!.body)) continue
		// A region-abbreviation-SHAPED head (2-3 uppercase letters) starts a LOCALITY_PHRASE only when
		// place-name content follows it. This keeps a standalone trailing "NY"/"TX" owned by
		// REGION_ABBREVIATION, while still forming "SAN NAZARIO" / "CITTÀ DI CASTELLO" — in all-caps
		// intl data (OpenAddresses), the head/connector of a place name ("SAN", "DI", "DEL") matches
		// the abbreviation shape, so a hard skip here dropped the multi-word locality entirely (#425).
		if (isRegionAbbreviation(tokens[i]!.body)) {
			const after = tokens[i + 1]
			if (!after || !(isPlaceNameContent(after.body) || isPlaceNameParticle(after.body))) continue
		}
		// Walk forward grabbing place-name content. Bridge connective particles (lowercase "de"/"in" or
		// all-caps "DI"/"DEL") ONLY when a content token follows within a short run (≤2 consecutive
		// particles: "aan den Rijn"), so a dangling "Palmas de" at end-of-segment doesn't extend the
		// run. Stop on digits, street suffixes, and NON-particle region abbreviations ("Springfield IL"
		// must not absorb "IL").
		let j = i
		for (;;) {
			const next = tokens[j + 1]
			if (!next) break
			const b = next.body
			if (isAllDigit(b) || isStreetSuffix(b) || isStreetPrefix(b)) break
			if (isRegionAbbreviation(b) && !isPlaceNameParticle(b)) break
			if (isPlaceNameContent(b) && !isPlaceNameParticle(b)) {
				j++
				continue
			}
			if (isPlaceNameParticle(b)) {
				// Look past a short run of consecutive particles for the next content token.
				let k = j + 2
				while (tokens[k] && isPlaceNameParticle(tokens[k]!.body)) k++
				if (tokens[k] && k - (j + 1) <= 2 && isPlaceNameContent(tokens[k]!.body)) {
					j = k // jump onto the content token; the bridged particles stay inside the span
					continue
				}
			}
			break
		}
		// Emit proposals for every prefix-length of the run starting at i, capped at 6 tokens (covers
		// "Las Palmas de Gran Canaria" = 5). Each starting i contributes ≤6 proposals → O(n) per segment.
		const maxLen = Math.min(j - i + 1, 6)
		for (let len = 1; len <= maxLen; len++) {
			const startTok = tokens[i]!
			const endTok = tokens[i + len - 1]!
			// Never end a proposal ON a connective particle ("Las Palmas de" / "CITTÀ DI" is not a place).
			if (isPlaceNameParticle(endTok.body)) continue
			const spanText = text.slice(startTok.start, endTok.end)
			const isRegionName = len === 1 && US_REGION_NAMES.has(spanText.toLowerCase())
			const atTail = i + len - 1 === tokens.length - 1
			const lenBonus = len === 2 ? 0.15 : len === 3 ? 0.12 : len >= 4 ? 0.08 : 0
			let confidence = 0.55 + lenBonus
			if (isRegionName && !atTail) confidence -= 0.2
			if (atTail && segmentIsLast) confidence += 0.1
			if (atTail) confidence += 0.05
			out.push({
				span: makeSection(text, startTok.start, endTok.end),
				kindHypothesis: "LOCALITY_PHRASE",
				confidence: Math.min(0.95, confidence),
			})
		}
		// Do NOT skip past the run — let i++ advance normally so every capitalized token gets a
		// chance to emit single-token proposals from its own starting position. (Saint Petersburg
		// needs `Saint`, `Petersburg`, AND `Saint Petersburg`; a run-skip would lose `Petersburg`.)
	}
	return out
}

/**
 * `VENUE_PHRASE` rule: capitalized run containing a venue-marker noun (Steakhouse, Hotel, etc.) OR
 * containing a hyphenated compound + ≥1 capitalized word.
 *
 * The shape "NY-NY Steakhouse" — the kryptonite case the reconciler eventually needs to lift the NY
 * tokens off REGION — surfaces here as a `VENUE_PHRASE` proposal at moderate-high confidence.
 *
 * Also includes a venue-by-exclusion positional prior: multi-word capitalized run in the first
 * segment with no street suffix, no house number, and no unit marker → weak VENUE_PHRASE at
 * 0.50-0.55. The idea: if we can't identify what something IS, but it's in the venue slot (first
 * segment) and doesn't look like any other component, it might be a venue name.
 */
export function scoreVenuePhrase(
	tokens: ReadonlyArray<SegmentToken>,
	text: string,
	segmentIsFirst?: boolean
): PhraseProposal[] {
	const out: PhraseProposal[] = []
	let i = 0
	while (i < tokens.length) {
		if (!startsCapitalized(tokens[i]!.body)) {
			i++
			continue
		}
		let j = i
		while (j + 1 < tokens.length && (startsCapitalized(tokens[j + 1]!.body) || tokens[j + 1]!.body.includes("-"))) {
			j++
		}
		const run = tokens.slice(i, j + 1)
		const markerWeight = venueMarkerWeight(run)
		const hasHyphenCompound = run.some((t) => /[^-]-[^-]/.test(t.body))

		if (markerWeight > 0 || (hasHyphenCompound && run.length >= 2)) {
			const startTok = run[0]!
			const endTok = run[run.length - 1]!
			const confidence = markerWeight > 0 ? markerWeight : 0.65
			out.push({
				span: makeSection(text, startTok.start, endTok.end),
				kindHypothesis: "VENUE_PHRASE",
				confidence,
			})
		} else if (segmentIsFirst && run.length >= 2) {
			const hasStreet = run.some((t) => isStreetSuffix(t.body))
			const hasLeadingNum = isAllDigit(run[0]!.body)
			const hasUnit = hasUnitMarker(run)
			if (!hasStreet && !hasLeadingNum && !hasUnit) {
				const startTok = run[0]!
				const endTok = run[run.length - 1]!
				out.push({
					span: makeSection(text, startTok.start, endTok.end),
					kindHypothesis: "VENUE_PHRASE",
					confidence: run.length >= 3 ? 0.55 : 0.5,
				})
			}
		}

		i = j + 1
	}
	return out
}
