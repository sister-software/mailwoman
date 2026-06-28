/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convert a solved v0 (rule) parser solution into `ClassificationProposal`s (#478 increment 3).
 *
 *   The arbitration layer's "rule source" is NOT the raw firings of individual legacy classifiers —
 *   those are uncoordinated (every classifier fires on every span) and only become a coherent parse
 *   after the v0 solver chain (filters, penalties, declassifiers) runs. So the rule proposals fed
 *   to arbitration are derived from a _solved_ `SerializedSolution` (the v0 parser's actual
 *   output), one proposal per surviving match — preserving the span offsets and confidence the
 *   solver settled on.
 *
 *   Spans are structural (`{ start, end, body }`) to avoid forcing the tokenization module's
 *   filesystem-bound init; downstream proposal consumers read only `start` / `end` / `body`.
 */

import type { SerializedSolution } from "../solver/index.js"
import type { Span } from "../tokenization/index.js"
import { type ClassificationProposal, legacyClassificationToComponentTag } from "../types/index.js"

/**
 * Project a solved v0 solution's matches into `rule`-sourced proposals. Matches whose legacy classification has no
 * `ComponentTag` mapping (e.g. structural-only tags) are skipped.
 *
 * @param solution A `SerializedSolution` from `AddressParser.parse()` (typically the top solution).
 * @param sourceId Stable id surfaced as `source_id` (default `"rule"`).
 */
export function solutionToProposals(solution: SerializedSolution, sourceId = "rule"): ClassificationProposal[] {
	const proposals: ClassificationProposal[] = []

	for (const match of solution.matches) {
		const component = legacyClassificationToComponentTag(match.classification)

		if (!component) continue

		const span = { start: match.start, end: match.end, body: match.value } as unknown as Span
		proposals.push({
			span,
			component,
			confidence: match.confidence,
			source: "rule",
			source_id: sourceId,
			penalty: 0,
		})
	}

	return proposals
}
