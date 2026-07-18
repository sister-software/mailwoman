/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `classifyKind` — entry point for Stage 2.5 (kind classification).
 *
 *   Composes the per-kind rules from `rules.ts` and picks the winner. Returns alternatives sorted by
 *   confidence so the coordinator can offer fallback paths when the top kind isn't actionable.
 *
 *   Per the project's "possibilities not constraints" principle, every kind that fires above 0
 *   surfaces in `alternatives` — the caller decides whether to act on the top kind only or consider
 *   runner-ups.
 */

import { createScorePOIQuery, type POIPhraseLookup } from "./poi.ts"
import {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
	scoreVenueLandmark,
} from "./rules.ts"
import type { LocaleHint, NormalizedInputLite, QueryKind, QueryKindResult, QueryShapeLike } from "./types.ts"

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
	{ kind: "vague", score: scoreVague },
]

/**
 * Classify the query shape into a `QueryKind`. Synchronous + pure — produces the same result for the same `(input,
 * shape)` pair.
 */
export function classifyKindSync(input: NormalizedInputLite, shape: QueryShapeLike): QueryKindResult {
	const scored = SCORERS.map((s) => ({ kind: s.kind, confidence: s.score(input, shape) })).filter(
		(s) => s.confidence > 0
	)
	scored.sort((a, b) => b.confidence - a.confidence)

	const top = scored[0] ?? { kind: "vague" as QueryKind, confidence: 0.3 }
	const alternatives = scored.slice(1).map((s) => ({ kind: s.kind, confidence: s.confidence }))

	return {
		kind: top.kind,
		confidence: top.confidence,
		alternatives,
	}
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

/** Options for {@link createKindClassifier}. */
export interface KindClassifierOpts {
	/**
	 * POI phrase lexicon (spec §3.1). When present, a `poi_query` scorer joins the rule set — injected, never imported,
	 * so this package stays dictionary-free. Absent → the returned classifier is behaviorally identical to
	 * {@link classifyKind}.
	 */
	poiLexicon?: POIPhraseLookup
}

/**
 * Build a kind classifier. Without opts this is exactly the default {@link classifyKind}; with a `poiLexicon` it
 * additionally scores `poi_query` and merges it into the ranked result.
 */
export function createKindClassifier(
	opts: KindClassifierOpts = {}
): (input: NormalizedInputLite, shape: QueryShapeLike, locale?: LocaleHint) => Promise<QueryKindResult> {
	const { poiLexicon } = opts

	if (!poiLexicon) return classifyKind

	return async (input, shape, locale) => {
		const base = classifyKindSync(input, shape)
		const poiConfidence = createScorePOIQuery(poiLexicon, locale?.locale)(input, shape)

		if (poiConfidence <= 0) return base

		if (poiConfidence > base.confidence) {
			return {
				kind: "poi_query",
				confidence: poiConfidence,
				alternatives: [{ kind: base.kind, confidence: base.confidence }, ...base.alternatives],
			}
		}

		return {
			...base,
			alternatives: [...base.alternatives, { kind: "poi_query", confidence: poiConfidence }].sort(
				(a, b) => b.confidence - a.confidence
			),
		}
	}
}
