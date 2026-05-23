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

import {
	scoreIntersection,
	scoreLandmark,
	scoreLocalityOnly,
	scorePoBox,
	scorePostcodeOnly,
	scoreStructuredAddress,
	scoreVague,
} from "./rules.js"
import type { LocaleHint, NormalizedInputLite, QueryKind, QueryKindResult, QueryShapeLike } from "./types.js"

interface KindScorer {
	kind: QueryKind
	score: (input: NormalizedInputLite, shape: QueryShapeLike) => number
}

const SCORERS: ReadonlyArray<KindScorer> = [
	{ kind: "po_box", score: scorePoBox },
	{ kind: "landmark", score: scoreLandmark },
	{ kind: "intersection", score: scoreIntersection },
	{ kind: "postcode_only", score: scorePostcodeOnly },
	{ kind: "locality_only", score: scoreLocalityOnly },
	{ kind: "structured_address", score: scoreStructuredAddress },
	{ kind: "vague", score: scoreVague },
]

/**
 * Classify the query shape into a `QueryKind`. Synchronous + pure — produces the same result for
 * the same `(input, shape)` pair.
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
 * The locale parameter is accepted for future locale-aware rules (Japanese honorifics, etc.) but
 * not currently used.
 */
export async function classifyKind(
	input: NormalizedInputLite,
	shape: QueryShapeLike,
	_locale?: LocaleHint
): Promise<QueryKindResult> {
	return classifyKindSync(input, shape)
}
