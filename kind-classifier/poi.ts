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

/** One lexicon hit for a candidate subject phrase. */
export interface POIPhraseMatch {
	/**
	 * The matched subject's identifier string. For `kind: "category"`, a `@mailwoman/poi-taxonomy` category id. For
	 * `kind: "brand"`, the brand's canonical display name (NOT a taxonomy id) — `matchPOISubject` never reads this field
	 * itself, so the caller (`mailwoman`'s `poi-intent.ts`) is the one that interprets it per `kind`.
	 */
	categoryID: string
	matchedPhrase: string
	confidence: number
	/** Which lexicon this hit came from. Existing category lookups set `"category"` (backward-compatible default). */
	/**
	 * Absent = "category" (the pre-brand shape) — optional so pre-7.3 POIPhraseLookup implementors stay
	 * source-compatible.
	 */
	kind?: "category" | "brand"
	/** Wikidata QID, when known. `kind: "brand"` only — absent when a brand resolved by name alone (no QID match). */
	wikidata?: string
}

/** Injected phrase→category lookup. Exact-phrase, locale-aware; returns [] on miss. */
export type POIPhraseLookup = (phrase: string, locale?: string) => ReadonlyArray<POIPhraseMatch>

export interface POISubjectMatch {
	match: POIPhraseMatch
	/** The matched subject text as it appeared in the query. */
	subject: string
	/** The anchor remainder after the separator; `""` when the whole input matched. */
	remainder: string
}

/**
 * Anchor separator between subject and place: comma, or near/in/at/around — scanned left-to-right until a prefix hits
 * the lexicon.
 */
const ANCHOR_SEPARATOR = /\s*,\s*|\s+(?:near|in|at|around)\s+/gi

/** Longest subject we accept, in tokens. Lexicon phrases are short; 4 covers the table. */
const MAX_SUBJECT_TOKENS = 4

/**
 * Match a POI subject: the whole input, or the text before the FIRST anchor separator WHOSE PREFIX HITS THE LEXICON (≤
 * 4 tokens). Scans separator occurrences left-to-right — a lexicon phrase may itself contain a bare separator word
 * (e.g. "walk in clinic"), so the first separator isn't necessarily the right split point. Returns null when the
 * lexicon never fires — including comma-ridden full addresses whose leading segment isn't a lexicon phrase.
 */
export function matchPOISubject(
	text: string,
	locale: string | undefined,
	lookup: POIPhraseLookup
): POISubjectMatch | null {
	const trimmed = text.trim()

	if (!trimmed) return null

	const whole = lookup(trimmed, locale)

	if (whole.length > 0) {
		return { match: whole[0]!, subject: trimmed, remainder: "" }
	}

	for (const separator of trimmed.matchAll(ANCHOR_SEPARATOR)) {
		if (separator.index === 0) continue

		const subject = trimmed.slice(0, separator.index).trim()

		// Subjects only grow as the scan moves right — once over budget, later splits are too.
		if (subject.split(/\s+/).length > MAX_SUBJECT_TOKENS) break

		const hits = lookup(subject, locale)

		if (hits.length === 0) continue

		const remainder = trimmed.slice(separator.index + separator[0].length).trim()

		return { match: hits[0]!, subject, remainder }
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

		if (segCount > 3) return 0

		return 0.9 * matched.match.confidence
	}
}
