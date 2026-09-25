/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Removes overlapping proposals before a flat address tree is built.
 */

import type { ClassificationProposal } from "#types/index"

/**
 * Returns whether two half-open spans overlap.
 */
function spansOverlap(a: ClassificationProposal["span"], b: ClassificationProposal["span"]): boolean {
	return a.start < b.end && b.start < a.end
}

/**
 * Selects non-overlapping proposals and returns them in span order.
 * The input array is left unchanged.
 *
 * Proposals are ranked by higher confidence, then shorter span, then earlier start.
 * A greedy pass keeps each proposal that overlaps none already kept.
 */
export function resolveProposalOverlaps(proposals: readonly ClassificationProposal[]): ClassificationProposal[] {
	if (proposals.length <= 1) return [...proposals]

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	const ranked = [...proposals].sort((a, b) => {
		if (b.confidence !== a.confidence) return b.confidence - a.confidence
		const lenA = a.span.end - a.span.start
		const lenB = b.span.end - b.span.start

		if (lenA !== lenB) return lenA - lenB

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
