/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * POI subject detection for the `poi_query` kind. The lexicon is injected (`POIPhraseLookup`) so this
 * package keeps its bitter-lesson invariant (no dictionaries in-tree); the phrase table lives in
 * `@mailwoman/poi-taxonomy` and is wired in by `createRuntimePipeline` behind the `poiQueryKind` flag.
 * Spec §3.1.
 */

import type { NormalizedInputLite, QueryShapeSegmentsView as QueryShapeLike } from "@mailwoman/query-shape"
/**
 * Comma-segment ceiling for a POI-led query; past it the input is a venue plus a full address
 * (`X, 350 5th Ave, New York, NY`), which the structured-address scorer should claim instead.
 */
const MAX_POI_SEGMENTS = 3

/**
 * One lexicon hit for a candidate subject phrase.
 */
export interface POIPhraseMatch {
	/**
	 * The matched subject's identifier: a `@mailwoman/poi-taxonomy` category id for
	 * `kind: "category"`, otherwise the canonical display name; `matchPOISubject`
	 * treats it opaquely and the caller interprets it per `kind`.
	 */
	categoryID: string
	matchedPhrase: string
	confidence: number
	mechanism?: "exact" | "locale_normalized" | "typo"
	inputPhrase?: string
	/**
	 * Absent means `"category"`; optional so existing `POIPhraseLookup` implementors stay source-compatible.
	 */
	kind?: "category" | "brand" | "name"
	/**
	 * Wikidata QID when known, `kind: "brand"` only; absent when a brand resolved by name alone.
	 */
	wikidata?: string
	/**
	 * Whether this hit is one member of a set the caller must search together
	 * rather than one candidate in a preference list.
	 *
	 * A lookup returning several hits means two different things: a phrase index
	 * returns the categories one typed phrase could name, the curated reading first
	 * (`credit union` → the `bank` rollup its synonym redirects to), while an affordance
	 * rung returns every entity kind that affords one activity in a stable enumeration that
	 * is not a preference, and narrowing to the first would be an invented ordering.
	 * Set on every member of such a set, so {@link matchPOISubject} carries them all and the POI branch
	 * searches their union; absent — the committed lexicon's shape — keeps the first-hit reading.
	 */
	searchAsSet?: boolean
	/**
	 * ISO 3166-1 alpha-2 countries the authority behind this hit scopes its claim to;
	 * absent means the condition is true everywhere.
	 *
	 * A scope is a statement about establishments, so it is judged against the country of
	 * the place being searched rather than the caller's locale: the locale is the lens the
	 * phrase is read through and makes no statement about where the condition is true.
	 * `matchPOISubject` carries the value untouched, and the POI intent stage
	 * binds it once the anchor has resolved.
	 */
	countryScope?: readonly string[]
}

/**
 * Injected phrase→category lookup, exact-phrase and locale-aware, returning `[]` on miss.
 */
export type POIPhraseLookup = (phrase: string, locale?: string) => ReadonlyArray<POIPhraseMatch>

export type POISpatialRelation = "comma" | "near" | "in" | "at" | "around" | "to"

export interface POIQuerySpan {
	text: string
	/**
	 * Half-open character offsets into the normalized input.
	 */
	start: number
	end: number
}

/**
 * Which lexicon this hit came from; existing category lookups set `"category"`
 * as the backward-compatible default.
 */
export interface POISubjectMatch {
	/**
	 * The hit the subject scores under; always `matches[0]`, built together in one place
	 * so they cannot disagree.
	 */
	match: POIPhraseMatch
	/**
	 * Every category the subject reaches, `match` first: one entry unless the lookup returned
	 * a {@link POIPhraseMatch.searchAsSet} set, in which case it holds the whole set and the
	 * POI branch searches their union; the order is the lookup's and states no preference.
	 */
	matches: POIPhraseMatch[]
	subject: string
	subjectSpan: POIQuerySpan
	/**
	 * The relation crossing from the subject span to the anchor span.
	 */
	relation?: POISpatialRelation
	relationSpan?: POIQuerySpan
	/**
	 * The anchor remainder after the separator; `""` when the whole input matched.
	 */
	remainder: string
	anchorSpan?: POIQuerySpan
}

/**
 * Anchor separator between subject and place: comma, or near/in/at/around/to —
 * scanned left-to-right until a prefix hits the lexicon.
 *
 * Linear by construction (no polynomial ReDoS): neither alternative places an unbounded
 * whitespace quantifier before its required literal, the classic `js/polynomial-redos` shape.
 * The comma alternative starts at the literal `,`, the anchor alternative at a single `\s`
 * before a fixed anchor word, and every remaining quantifier is trailing, running only after
 * the required literal has matched, so each start offset does O(1) work and `matchAll` is O(n).
 *
 * Behaviour is byte-identical to the previous `\s*,\s*|\s+(?:…)\s+`, because `matchPOISubject`
 * trims both the subject and the remainder, so surrounding whitespace is redundant;
 * the leading quantifier only shifted the match start within a whitespace run, while the retained
 * trailing greedy quantifier keeps the match end and thus `matchAll`'s lastIndex identical.
 */
const ANCHOR_SEPARATOR = /,\s*|\s(near|in|at|around|to)\s+/gi

/**
 * Longest subject accepted, in tokens: eight covers compound taxonomy phrases
 * while bounding lexicon probes.
 */
const MAX_SUBJECT_TOKENS = 8

/**
 * The categories one candidate subject reaches: the whole array when the first hit
 * declares {@link POIPhraseMatch.searchAsSet}, carried as the lookup returned it
 * and never filtered so a rung that flagged only some members keeps every member
 * and the inconsistency stays visible, otherwise the first hit alone.
 */
function reachedMatches(hits: ReadonlyArray<POIPhraseMatch>): POIPhraseMatch[] {
	return hits[0]!.searchAsSet ? [...hits] : [hits[0]!]
}

/**
 * Match a POI subject: the whole input, or the text before the first anchor
 * separator whose prefix hits the lexicon (≤ 8 tokens).
 *
 * Scans separators left-to-right, because a lexicon phrase may itself contain a bare
 * separator word ("walk in clinic") and the first separator is not necessarily the
 * right split point; returns null when the lexicon never fires, including comma-ridden
 * full addresses whose leading segment is not a phrase.
 *
 * The winning candidate's hits are carried per {@link reachedMatches}.
 */
export function matchPOISubject(
	text: string,
	locale: string | undefined,
	lookup: POIPhraseLookup
): POISubjectMatch | null {
	const trimmed = text.trim()
	const inputStart = text.indexOf(trimmed)

	if (!trimmed) return null

	const whole = lookup(trimmed, locale)

	if (whole.length) {
		const matches = reachedMatches(whole)

		return {
			match: matches[0]!,
			matches,
			subject: trimmed,
			subjectSpan: { text: trimmed, start: inputStart, end: inputStart + trimmed.length },
			remainder: "",
		}
	}

	for (const separator of trimmed.matchAll(ANCHOR_SEPARATOR)) {
		if (separator.index === 0) continue

		const subject = trimmed.slice(0, separator.index).trim()

		// Subjects only grow as the scan moves right, so once over budget later splits are too;
		// whitespace-only split rather than `wordsOf`, because a comma inside a subject is real content.
		if (subject.split(/\s+/).length > MAX_SUBJECT_TOKENS) break

		const hits = lookup(subject, locale)

		if (!hits.length) continue

		const remainder = trimmed.slice(separator.index + separator[0].length).trim()

		if (!remainder) continue

		const subjectOffset = trimmed.slice(0, separator.index).indexOf(subject)
		const anchorOffset = trimmed.indexOf(remainder, separator.index + separator[0].length)
		const relationText = separator[1] ?? ","
		const relationOffset = separator[1] ? separator.index + separator[0].indexOf(separator[1]) : separator.index
		const matches = reachedMatches(hits)

		return {
			match: matches[0]!,
			matches,
			subject,
			subjectSpan: {
				text: subject,
				start: inputStart + subjectOffset,
				end: inputStart + subjectOffset + subject.length,
			},
			relation: relationText === "," ? "comma" : (relationText.toLowerCase() as POISpatialRelation),
			relationSpan: {
				text: relationText,
				start: inputStart + relationOffset,
				end: inputStart + relationOffset + relationText.length,
			},
			remainder,
			anchorSpan: {
				text: remainder,
				start: inputStart + anchorOffset,
				end: inputStart + anchorOffset + remainder.length,
			},
		}
	}

	return null
}

/**
 * `poi_query` scorer over an injected lexicon, with confidence bands: a whole-input lexicon hit
 * scores 0.92 (above venue-landmark's 0.88 ceiling, because an exact phrase beats a shape heuristic)
 * and a subject plus anchor 0.9.
 *
 * The guards keep venue-led full addresses (class 2) on the structured-address path:
 * a remainder leading with a house number, or a 4+-segment input, scores 0.
 */
export function createScorePOIQuery(
	lookup: POIPhraseLookup,
	locale?: string
): (input: NormalizedInputLite, shape: QueryShapeLike) => number {
	return (input, shape) => {
		const matched = matchPOISubject(input.normalized, locale ?? input.appliedLocale, lookup)

		if (!matched) return 0

		if (matched.remainder === "") return 0.92 * matched.match.confidence

		// Venue-led full address: "X, 350 5th Ave, …" stays a structured_address parse.
		if (/^\d+\s/.test(matched.remainder)) return 0

		const segCount = shape.segments?.length ?? 1

		if (segCount > MAX_POI_SEGMENTS) return 0

		return 0.9 * matched.match.confidence
	}
}

/**
 * Confidence band for a bare category, one notch above `poi_query`'s whole-input
 * band (0.92) so only the anchorless subset takes the top slot and every anchored
 * POI query keeps scoring `poi_query` as before.
 *
 * The coordinator's POI branch accepts both kinds, so the routing is identical either way;
 * the split exists so the marker can say "you named a category and no place".
 */
const POI_CATEGORY_CONFIDENCE = 0.93

/**
 * `poi_category` scorer (ROAD_TO_V9 §4.4) — a bare taxonomy category with nowhere
 * to search: "tacos", "grocery store", "drinking fountain".
 *
 * Fires only on a whole-input lexicon hit (`remainder === ""`) whose subject is a category;
 * a brand (`kind: "brand"`) is excluded because `POIPhraseMatch.categoryID` then holds
 * the brand's display name, which would make the marker's `categoryID` evidence a lie.
 */
export function createScorePOICategory(
	lookup: POIPhraseLookup,
	locale?: string
): (input: NormalizedInputLite, shape: QueryShapeLike) => number {
	return (input, _shape) => {
		const matched = matchPOISubject(input.normalized, locale ?? input.appliedLocale, lookup)

		if (!matched || matched.remainder !== "") return 0

		if ((matched.match.kind ?? "category") !== "category") return 0

		return POI_CATEGORY_CONFIDENCE * matched.match.confidence
	}
}

/**
 * The whole-input category hit behind a `poi_category` verdict, for the marker's evidence;
 * `null` when the input is not a bare category, under the same conditions as
 * {@link createScorePOICategory} so the two cannot disagree.
 */
export function matchPOICategory(
	text: string,
	locale: string | undefined,
	lookup: POIPhraseLookup
): POIPhraseMatch | null {
	const matched = matchPOISubject(text, locale, lookup)

	if (!matched || matched.remainder !== "") return null

	if ((matched.match.kind ?? "category") !== "category") return null

	return matched.match
}
