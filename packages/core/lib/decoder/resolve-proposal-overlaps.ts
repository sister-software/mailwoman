/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Remove overlapping proposals before building a flat address tree. Proposals are ranked by
 *   confidence, then shorter span, then earlier start; a greedy pass keeps non-overlapping spans.
 */

import type { ClassificationProposal } from "#types/index"

/**
 * Return whether two half-open spans overlap.
 */
function spansOverlap(a: ClassificationProposal["span"], b: ClassificationProposal["span"]): boolean {
	return a.start < b.end && b.start < a.end
}

/**
 * Select non-overlapping proposals and return them in span order without mutating the input.
 */
export function resolveProposalOverlaps(proposals: readonly ClassificationProposal[]): ClassificationProposal[] {
	if (proposals.length <= 1) return [...proposals]

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	const ranked = [...proposals].sort((a, b) => {
		if (b.confidence !== a.confidence) return b.confidence - a.confidence // Prefer higher confidence.
		const lenA = a.span.end - a.span.start
		const lenB = b.span.end - b.span.start

		if (lenA !== lenB) return lenA - lenB

		// Prefer finer spans, then earlier starts.
		return a.span.start - b.span.start
	})

	const kept: ClassificationProposal[] = []

	for (const proposal of ranked) {
		if (kept.every((k) => !spansOverlap(k.span, proposal.span))) {
			kept.push(proposal)
		}
	}

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	return kept.sort((a, b) => a.span.start - b.span.start)
}
