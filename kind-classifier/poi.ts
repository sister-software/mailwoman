/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POI subject detection for the `poi_query` kind. The lexicon is INJECTED (`POIPhraseLookup`) —
 *   this package keeps its bitter-lesson invariant (no dictionaries in-tree); the phrase table
 *   lives in `@mailwoman/poi-taxonomy` and is wired in by `createRuntimePipeline` behind the
 *   `poiQueryKind` flag (default-ON since 2026-07-20). Spec §3.1.
 */

import type { NormalizedInputLite, QueryShapeLike } from "./types.ts"

/**
 * Comma-segment ceiling for a POI-led query. Past it the input is a venue plus a full address (`X, 350 5th Ave, New
 * York, NY`), which the structured-address scorer should claim instead.
 */
const MAX_POI_SEGMENTS = 3

/**
 * One lexicon hit for a candidate subject phrase.
 */
export interface POIPhraseMatch {
	/**
	 * The matched subject's identifier string. For `kind: "category"`, a `@mailwoman/poi-taxonomy` category id; for
	 * `kind: "brand"` or `kind: "name"`, the canonical display name. `matchPOISubject` treats it opaquely; the caller
	 * (`mailwoman`'s `poi-intent.ts`) interprets it per `kind`.
	 */
	categoryID: string
	matchedPhrase: string
	confidence: number
	/**
	 * Absent = "category" (the pre-brand shape) — optional so pre-7.3 POIPhraseLookup implementors stay
	 * source-compatible.
	 */
	kind?: "category" | "brand" | "name"
	/**
	 * Wikidata QID, when known. `kind: "brand"` only — absent when a brand resolved by name alone (no QID match).
	 */
	wikidata?: string
}

/**
 * Injected phrase→category lookup. Exact-phrase, locale-aware; returns [] on miss.
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
 * Which lexicon this hit came from. Existing category lookups set `"category"` (backward-compatible default).
 */
export interface POISubjectMatch {
	match: POIPhraseMatch
	/**
	 * The matched subject text as it appeared in the query.
	 */
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
 * Anchor separator between subject and place: comma, or near/in/at/around/to — scanned left-to-right until a prefix
 * hits the lexicon.
 *
 * Linear by construction (no polynomial ReDoS): neither alternative places an unbounded whitespace quantifier _before_
 * its required literal — the classic `\s*`/`\s+`-then-literal backtracking shape that CodeQL's `js/polynomial-redos`
 * flags. The comma alternative starts at the literal `,`; the anchor alternative starts at a single `\s` immediately
 * before a fixed anchor word. Every remaining quantifier (`,\s*`, `…\s+`) is _trailing_ — it runs only after the
 * required literal has already matched and nothing follows it, so it never backtracks. Each start offset does O(1)
 * work, making `matchAll` O(n).
 *
 * Behaviour is byte-identical to the previous `\s*,\s*|\s+(?:…)\s+` because `matchPOISubject` `.trim()`s both the
 * subject (text before `.index`) and the remainder (text after the match), so surrounding whitespace on either side of
 * the separator is redundant. The leading `\s*`/`\s+` only shifted the match _start_ within a whitespace run — trim
 * absorbs that — while the retained _trailing_ greedy quantifier keeps the match _end_ (and thus `matchAll`'s
 * lastIndex) identical, preserving the exact subsequent-match sequence. Verified: 0 divergences across 22.7k inputs
 * (systematic + fuzzed adversarial whitespace + shared-whitespace anchor/comma chains).
 */
const ANCHOR_SEPARATOR = /,\s*|\s(near|in|at|around|to)\s+/gi

/**
 * Longest subject we accept, in tokens. Eight covers compound taxonomy phrases while bounding lexicon probes.
 */
const MAX_SUBJECT_TOKENS = 8

/**
 * Match a POI subject: the whole input, or the text before the FIRST anchor separator WHOSE PREFIX HITS THE LEXICON (≤
 * 8 tokens). Scans separator occurrences left-to-right — a lexicon phrase may itself contain a bare separator word
 * (e.g. "walk in clinic"), so the first separator isn't necessarily the right split point. Returns null when the
 * lexicon never fires — including comma-ridden full addresses whose leading segment isn't a lexicon phrase.
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
		return {
			match: whole[0]!,
			subject: trimmed,
			subjectSpan: { text: trimmed, start: inputStart, end: inputStart + trimmed.length },
			remainder: "",
		}
	}

	for (const separator of trimmed.matchAll(ANCHOR_SEPARATOR)) {
		if (separator.index === 0) continue

		const subject = trimmed.slice(0, separator.index).trim()

		// Subjects only grow as the scan moves right — once over budget, later splits are too.
		if (subject.split(/\s+/).length > MAX_SUBJECT_TOKENS) break

		const hits = lookup(subject, locale)

		if (!hits.length) continue

		const remainder = trimmed.slice(separator.index + separator[0].length).trim()

		if (!remainder) continue

		const subjectOffset = trimmed.slice(0, separator.index).indexOf(subject)
		const anchorOffset = trimmed.indexOf(remainder, separator.index + separator[0].length)
		const relationText = separator[1] ?? ","
		const relationOffset = separator[1] ? separator.index + separator[0].indexOf(separator[1]) : separator.index

		return {
			match: hits[0]!,
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
 * `poi_query` scorer over an injected lexicon. Confidence bands: whole-input lexicon hit 0.92 (above venue-landmark's
 * 0.88 ceiling — an exact lexicon phrase beats a shape heuristic); subject + anchor 0.9. Guards below keep venue-led
 * FULL addresses (class 2) on the structured-address path: a remainder that leads with a house number, or a 4+-segment
 * input, scores 0 here.
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
 * Confidence band for a bare category. One notch above `poi_query`'s whole-input band (0.92) so the anchorless subset
 * takes the top slot from it, and only from it — every anchored POI query keeps scoring `poi_query` exactly as before.
 * The coordinator's POI branch accepts both kinds, so the routing is identical either way; the split exists so the
 * marker can say "you named a category and no place", which is a different thing to tell a caller.
 */
const POI_CATEGORY_CONFIDENCE = 0.93

/**
 * `poi_category` scorer (ROAD_TO_V9 §4.4) — a bare taxonomy category with nowhere to search: "tacos", "grocery store",
 * "drinking fountain".
 *
 * Fires ONLY on a whole-input lexicon hit (`remainder === ""`) whose subject is a CATEGORY. A brand (`kind: "brand"`)
 * is excluded: a bare "Starbucks" is a name lookup, not a category, and the taxonomy id a category marker promises to
 * carry does not exist for it — `POIPhraseMatch.categoryID` holds the brand's display name in that case, which would
 * make the marker's `categoryID` evidence a lie.
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
 * The whole-input category hit behind a `poi_category` verdict, for the marker's evidence. `null` when the input is not
 * a bare category — same gates as {@link createScorePOICategory}, so the two cannot disagree.
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
