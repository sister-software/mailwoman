/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isFloorDesignatorToken } from "@mailwoman/codex/us/floor-designator"
import { isStreetSuffixToken } from "@mailwoman/codex/us/street-suffix"
import { isUnitDesignatorToken } from "@mailwoman/codex/us/unit-designator"
import type { PhraseProposal } from "@mailwoman/core/pipeline"
import { isRegionAbbreviationToken, type QueryShapeTokensView as QueryShapeLike } from "@mailwoman/query-shape"

import {
	isAllDigit,
	LONG_PLACE_RUN_BONUS,
	makeSection,
	MAX_UNAMBIGUOUS_HOUSE_NUMBER_DIGITS,
	NEUTRAL_PROPOSAL_CONFIDENCE,
	NON_TAIL_REGION_NAME_PENALTY,
	PLACE_RUN_LENGTH_BONUS,
	SHORT_VENUE_RUN_CONFIDENCE,
	UNAMBIGUOUS_NUMERIC_CONFIDENCE,
	US_REGION_NAMES,
	VENUE_RUN_MIN_TOKENS,
	type SegmentToken,
} from "#rules/tokens"

/**
 * Re-exports the segment tokenizer and its token type so callers of these scoring
 * rules can build their `tokens` input from one module.
 */
export { tokenizeSegment, type SegmentToken } from "#rules/tokens"

function isRegionAbbreviation(s: string): boolean {
	return isRegionAbbreviationToken(s, { maxLetters: 3 })
}

function startsCapitalized(s: string): boolean {
	return /^\p{Lu}/u.test(s)
}

function isStreetSuffix(token: string): boolean {
	return isStreetSuffixToken(token.replace(/\.$/, ""))
}

const STREET_PREFIXES: ReadonlySet<string> = new Set([
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

	"rua",
	"travessa",
	"praça",

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

const PLACE_NAME_PARTICLES: ReadonlySet<string> = new Set([
	"de",
	"del",
	"la",
	"las",
	"los",
	"el",
	"i",

	"di",
	"della",
	"dei",
	"degli",
	"delle",
	"in",
	"a",
	"sul",
	"sulla",

	"du",
	"des",
	"le",
	"les",
	"sur",
	"sous",
	"en",
	"lès",

	"aan",
	"op",
	"den",
	"ter",
	"ten",

	"am",
	"an",
	"auf",
	"ob",
	"im",
	"vor",
	"bei",
	"der",
])

function isFusedParticleName(s: string): boolean {
	return /^\p{Ll}{1,6}['’]\p{Lu}/u.test(s)
}

function isPlaceNameContent(s: string): boolean {
	return startsCapitalized(s) || isFusedParticleName(s)
}

function isPlaceNameParticle(s: string): boolean {
	return PLACE_NAME_PARTICLES.has(s.toLowerCase())
}

const VENUE_MARKERS: ReadonlyMap<string, number> = new Map([
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

	["hotel", 0.9],
	["motel", 0.9],
	["inn", 0.75],
	["resort", 0.85],
	["lodge", 0.75],
	["hostel", 0.85],

	["theater", 0.85],
	["theatre", 0.85],
	["cinema", 0.85],
	["stadium", 0.9],
	["arena", 0.85],
	["museum", 0.85],
	["gallery", 0.75],
	["casino", 0.85],
	["lounge", 0.7],

	["market", 0.7],
	["mall", 0.8],
	["plaza", 0.7],
	["tower", 0.65],
	["center", 0.6],
	["centre", 0.6],

	["hospital", 0.9],
	["clinic", 0.85],
	["pharmacy", 0.85],

	["university", 0.9],
	["college", 0.85],
	["school", 0.8],
	["academy", 0.8],

	["church", 0.8],
	["temple", 0.8],
	["mosque", 0.8],
	["synagogue", 0.85],
	["cathedral", 0.85],
	["chapel", 0.75],
	["library", 0.85],

	["park", 0.6],
	["gardens", 0.65],
	["ranch", 0.7],
	["farm", 0.65],
])

const UNIT_MARKER_EXTENSIONS: ReadonlySet<string> = new Set(["#"])

function isUnitMarker(token: string): boolean {
	const bare = token.replace(/\.$/, "")

	return UNIT_MARKER_EXTENSIONS.has(token) || isUnitDesignatorToken(bare) || isFloorDesignatorToken(bare)
}

function venueMarkerWeight(tokens: ReadonlyArray<SegmentToken>): number {
	let maxWeight = 0

	for (const t of tokens) {
		const w = VENUE_MARKERS.get(t.body.toLowerCase())

		if (w !== undefined && w > maxWeight) {
			maxWeight = w
		}
	}

	return maxWeight
}

/**
 * Reports whether any token is a unit or floor designator, or a bare `#`.
 */
export function hasUnitMarker(tokens: ReadonlyArray<SegmentToken>): boolean {
	return tokens.some((t) => isUnitMarker(t.body))
}

/**
 * Proposes a `NUMERIC` span for each all-digit token, with high confidence up to four digits
 * and neutral confidence beyond, where a postcode reading competes.
 */
export function scoreNumeric(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []

	for (const t of tokens) {
		if (!isAllDigit(t.body)) continue
		const len = t.body.length

		const confidence =
			len <= MAX_UNAMBIGUOUS_HOUSE_NUMBER_DIGITS ? UNAMBIGUOUS_NUMERIC_CONFIDENCE : NEUTRAL_PROPOSAL_CONFIDENCE

		out.push({
			span: makeSection(text, t.start, t.end),
			kindHypothesis: "NUMERIC",
			confidence,
		})
	}

	return out
}

/**
 * Publishes each non-PO-box known-format hit from the query shape as a `POSTCODE`
 * proposal at the hit's own confidence.
 */
export function scorePostcode(shape: QueryShapeLike, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []

	for (const hit of shape.knownFormats) {
		if (hit.format === "po_box") continue

		out.push({
			span: makeSection(text, hit.span.start, hit.span.end),
			kindHypothesis: "POSTCODE",

			confidence: hit.confidence,
		})
	}

	return out
}

/**
 * Proposes a `REGION_ABBREVIATION` span for each short uppercase region-code token,
 * most confidently at the end of a segment.
 *
 * A token followed by a capitalized place word is skipped, because it is more likely the start of a name.
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

		const after = tokens[i + 1]

		if (after && isPlaceNameContent(after.body) && !isRegionAbbreviation(after.body) && !isStreetSuffix(after.body)) {
			continue
		}

		const atTail = i === tokens.length - 1
		const confidence = atTail ? 0.85 : segmentIsLast ? 0.7 : NEUTRAL_PROPOSAL_CONFIDENCE

		out.push({
			span: makeSection(text, t.start, t.end),
			kindHypothesis: "REGION_ABBREVIATION",
			confidence,
		})
	}

	return out
}

/**
 * Proposes each token with an internal hyphen, such as `Saint-Denis`, `NY-NY` or `10118-1234`,
 * as one `HYPHENATED_COMPOUND` unit without judging what the compound means.
 */
export function scoreHyphenatedCompound(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []

	for (const t of tokens) {
		if (!t.body.includes("-")) continue

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
 * Proposes `STREET_PHRASE` spans from capitalized runs ending in a street-type suffix
 * and from runs beginning with a Romance-language street prefix such as `rue` or `calle`.
 *
 * A leading house number raises the suffix-run confidence but is excluded from the span.
 */
export function scoreStreetPhrase(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []

	for (let suffixIdx = 0; suffixIdx < tokens.length; suffixIdx++) {
		if (!isStreetSuffix(tokens[suffixIdx]!.body)) continue

		let start = suffixIdx

		for (let i = suffixIdx - 1; i >= 0; i--) {
			const body = tokens[i]!.body

			if (isAllDigit(body) || /^\d+(st|nd|rd|th)$/i.test(body) || startsCapitalized(body)) {
				start = i
			} else {
				break
			}
		}

		if (start === suffixIdx) continue

		let hadHouseNumber = false

		if (isAllDigit(tokens[start]!.body)) {
			start += 1
			hadHouseNumber = true

			if (start === suffixIdx) continue
		}

		const startTok = tokens[start]!
		const endTok = tokens[suffixIdx]!

		const confidence = hadHouseNumber ? 0.9 : 0.75

		out.push({
			span: makeSection(text, startTok.start, endTok.end),
			kindHypothesis: "STREET_PHRASE",
			confidence,
		})
	}

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

		while (end > prefixIdx && isPlaceNameParticle(tokens[end]!.body)) {
			end--
		}

		const startTok = tokens[prefixIdx]!
		const endTok = tokens[end]!

		out.push({
			span: makeSection(text, startTok.start, endTok.end),
			kindHypothesis: "STREET_PHRASE",
			confidence: end > prefixIdx ? 0.72 : 0.5,
		})
	}

	return out
}

/**
 * Caps the length of a proposed locality phrase in tokens, and also caps the forward walk
 * so a long capitalized run does not cost quadratic time.
 */
export const MAX_LOCALITY_PHRASE_TOKENS = 6

/**
 * Proposes every `LOCALITY_PHRASE` prefix of each capitalized run, including runs joined
 * by place-name particles such as "de" or "sur", up to {@link MAX_LOCALITY_PHRASE_TOKENS}.
 *
 * Longer runs and runs at the segment tail score higher, and a lone US state
 * name away from the tail is penalized.
 */
export function scoreLocalityPhrase(
	tokens: ReadonlyArray<SegmentToken>,
	text: string,
	segmentIsLast: boolean
): PhraseProposal[] {
	const out: PhraseProposal[] = []

	for (let i = 0; i < tokens.length; i++) {
		if (!isPlaceNameContent(tokens[i]!.body)) continue

		if (isStreetPrefix(tokens[i]!.body)) continue

		if (isRegionAbbreviation(tokens[i]!.body)) {
			const after = tokens[i + 1]

			if (!after || !(isPlaceNameContent(after.body) || isPlaceNameParticle(after.body))) continue
		}

		let j = i

		for (;;) {
			if (j - i + 1 >= MAX_LOCALITY_PHRASE_TOKENS) break

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
				let k = j + 2

				while (tokens[k] && isPlaceNameParticle(tokens[k]!.body)) {
					k++
				}

				if (tokens[k] && k - (j + 1) <= 2 && isPlaceNameContent(tokens[k]!.body)) {
					j = k

					continue
				}
			}

			break
		}

		const maxLen = Math.min(j - i + 1, MAX_LOCALITY_PHRASE_TOKENS)

		for (let len = 1; len <= maxLen; len++) {
			const startTok = tokens[i]!
			const endTok = tokens[i + len - 1]!

			if (isPlaceNameParticle(endTok.body)) continue
			const spanText = text.slice(startTok.start, endTok.end)
			const isRegionName = len === 1 && US_REGION_NAMES.has(spanText.toLowerCase())
			const atTail = i + len - 1 === tokens.length - 1
			const lenBonus = PLACE_RUN_LENGTH_BONUS.get(len) ?? (len > VENUE_RUN_MIN_TOKENS ? LONG_PLACE_RUN_BONUS : 0)
			let confidence = NEUTRAL_PROPOSAL_CONFIDENCE + lenBonus

			if (isRegionName && !atTail) {
				confidence -= NON_TAIL_REGION_NAME_PENALTY
			}

			if (atTail && segmentIsLast) {
				confidence += 0.1
			}

			if (atTail) {
				confidence += 0.05
			}

			out.push({
				span: makeSection(text, startTok.start, endTok.end),
				kindHypothesis: "LOCALITY_PHRASE",
				confidence: Math.min(0.95, confidence),
			})
		}
	}

	return out
}

/**
 * Proposes a `VENUE_PHRASE` for each capitalized run that contains a venue-marker noun
 * such as "Hotel", or a hyphenated compound plus another word, as in "NY-NY Steakhouse".
 *
 * In the first segment, a multi-word run with no street suffix, leading number
 * or unit marker also gets a weak venue proposal.
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
			const endTok = run.at(-1)!
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
				const endTok = run.at(-1)!

				out.push({
					span: makeSection(text, startTok.start, endTok.end),
					kindHypothesis: "VENUE_PHRASE",
					confidence: run.length >= VENUE_RUN_MIN_TOKENS ? NEUTRAL_PROPOSAL_CONFIDENCE : SHORT_VENUE_RUN_CONFIDENCE,
				})
			}
		}

		i = j + 1
	}

	return out
}
