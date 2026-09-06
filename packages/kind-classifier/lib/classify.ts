/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `classifyKind` — entry point for Stage 2.5 (kind classification).
 *
 *   Composes the per-kind rules from `rules.ts` and `intent-rules.ts` and picks the winner. Returns
 *   alternatives sorted by confidence so the coordinator can offer fallback paths when the top kind
 *   isn't actionable.
 *
 *   Per the project's "possibilities not constraints" principle, every kind that fires above 0
 *   surfaces in `alternatives` — the caller decides whether to act on the top kind only or consider
 *   runner-ups. The ROAD_TO_V9 §4 intent vocabulary leans on that: `bare_toponym` and `route_pair`
 *   are scored below their structural incumbent precisely so they land in `alternatives`, where they
 *   inform the markers without moving the routing decision.
 */

import type { LocaleHint, QueryIntentMarker, QueryKind, QueryKindResult } from "@mailwoman/core/pipeline"
import type { NormalizedInputLite, QueryShapeSegmentsView as QueryShapeLike } from "@mailwoman/query-shape"

import { deriveIntentMarkers } from "#intent-markers"
import { scoreBareToponym, scoreNearMe, scoreRoutePair } from "#intent-rules"
import { createScorePOICategory, createScorePOIQuery, type POIPhraseLookup } from "#poi"
import {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "#rules"

interface KindScorer {
	kind: QueryKind
	score: (input: NormalizedInputLite, shape: QueryShapeLike) => number
}

const SCORERS: ReadonlyArray<KindScorer> = [
	{ kind: "po_box", score: scorePoBox },
	{ kind: "landmark", score: (i, s) => Math.max(scoreLandmark(i, s), scoreVenueLandmark(i, s)) },
	{ kind: "intersection", score: scoreIntersection },
	{ kind: "postcode_only", score: scorePostcodeOnly },
	{ kind: "locality_only", score: scoreLocalityOnly },
	{ kind: "structured_address", score: scoreStructuredAddress },
	// ROAD_TO_V9 §4. Ordinary members of the same list — intent is vocabulary, not a stage. `bare_toponym` and
	// `route_pair` are scored under `locality_only` on purpose (see `intent-rules.ts`), so their position here is
	// cosmetic; the sort below is what decides.
	{ kind: "bare_toponym", score: scoreBareToponym },
	{ kind: "route_pair", score: scoreRoutePair },
	{ kind: "near_me", score: scoreNearMe },
	{ kind: "vague", score: scoreVague },
]

/**
 * Rank a scored list and shape it into a verdict. Shared by the lexicon-free and lexicon-wired paths so the two cannot
 * drift in how they break ties or build `alternatives`.
 */
function rank(scored: Array<{ kind: QueryKind; confidence: number }>): QueryKindResult {
	scored.sort((a, b) => b.confidence - a.confidence)

	const top = scored[0] ?? { kind: "vague" as QueryKind, confidence: 0.3 }

	return {
		kind: top.kind,
		confidence: top.confidence,
		alternatives: scored.slice(1).map((s) => ({ kind: s.kind, confidence: s.confidence })),
	}
}

/**
 * Every kind whose verdict carries `intentMarkers`. Checked before the marker builder runs so the hot path — a
 * structured address, where none of these fire — pays one set membership test per kind and nothing else.
 */
const MARKER_BEARING_KINDS: ReadonlySet<QueryKind> = new Set<QueryKind>(["route_pair", "near_me", "poi_category"])

/**
 * Attach markers to a verdict, or return it untouched. Separate from {@link rank} because the lexicon-wired path needs
 * to merge `poi_query`/`poi_category` in first.
 */
function withIntentMarkers(
	verdict: QueryKindResult,
	input: NormalizedInputLite,
	poiLexicon?: POIPhraseLookup,
	locale?: string
): QueryKindResult {
	const kinds = [{ kind: verdict.kind, confidence: verdict.confidence }, ...verdict.alternatives]

	if (!kinds.some((k) => MARKER_BEARING_KINDS.has(k.kind))) return verdict

	const intentMarkers: QueryIntentMarker[] = deriveIntentMarkers(kinds, { input, poiLexicon, locale })

	if (!intentMarkers.length) return verdict

	return { ...verdict, intentMarkers }
}

/**
 * Classify the query shape into a `QueryKind`. Synchronous + pure — produces the same result for the same `(input,
 * shape)` pair.
 */
export function classifyKindSync(input: NormalizedInputLite, shape: QueryShapeLike): QueryKindResult {
	const scored = SCORERS.map((s) => ({ kind: s.kind, confidence: s.score(input, shape) })).filter(
		(s) => s.confidence > 0
	)

	return withIntentMarkers(rank(scored), input)
}

/**
 * Async variant matching the runtime-pipeline's `classifyKind` contract.
 *
 * The locale parameter is accepted for future locale-aware rules (Japanese honorifics, etc.) but not currently used.
 */
export async function classifyKind(
	input: NormalizedInputLite,
	shape: QueryShapeLike,
	_locale?: LocaleHint
): Promise<QueryKindResult> {
	return classifyKindSync(input, shape)
}

/**
 * Options for {@link createKindClassifier}.
 */
export interface KindClassifierOpts {
	/**
	 * POI phrase lexicon (spec §3.1). When present, `poi_query` and `poi_category` scorers join the rule set — injected,
	 * never imported, so this package stays dictionary-free. Absent → the returned classifier is behaviorally identical
	 * to {@link classifyKind}.
	 */
	poiLexicon?: POIPhraseLookup
}

/**
 * Build a kind classifier. Without opts this is exactly the default {@link classifyKind}; with a `poiLexicon` it
 * additionally scores `poi_query` + `poi_category` (ROAD_TO_V9 §4.4) and merges them into the ranked result.
 */
export function createKindClassifier(
	opts: KindClassifierOpts = {}
): (input: NormalizedInputLite, shape: QueryShapeLike, locale?: LocaleHint) => Promise<QueryKindResult> {
	const { poiLexicon } = opts

	if (!poiLexicon) return classifyKind

	return async (input, shape, locale): Promise<QueryKindResult> => {
		const localeTag = locale?.locale
		const base = classifyKindSync(input, shape)
		const poiConfidence = createScorePOIQuery(poiLexicon, localeTag)(input, shape)
		const categoryConfidence = createScorePOICategory(poiLexicon, localeTag)(input, shape)

		if (poiConfidence <= 0 && categoryConfidence <= 0) return base

		// Re-rank over the union rather than special-casing "did POI beat the base?". The base verdict's own
		// alternatives are preserved, which is what keeps `bare_toponym` / `route_pair` visible to the marker builder
		// even when a POI kind takes the top slot.
		const merged: Array<{ kind: QueryKind; confidence: number }> = [
			{ kind: base.kind, confidence: base.confidence },
			...base.alternatives,
		]

		if (poiConfidence > 0) {
			merged.push({ kind: "poi_query", confidence: poiConfidence })
		}

		if (categoryConfidence > 0) {
			merged.push({ kind: "poi_category", confidence: categoryConfidence })
		}

		return withIntentMarkers(rank(merged), input, poiLexicon, localeTag)
	}
}
