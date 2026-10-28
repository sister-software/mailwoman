/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Removes overlapping proposals before a flat address tree is built.
 */

import type { ClassificationProposal } from "#types"

/**
 * Returns whether two half-open spans overlap.
 */
function spansOverlap(a: ClassificationProposal["span"], b: ClassificationProposal["span"]): boolean {
	return a.start < b.end && b.start < a.end
}

/**
 * The ranking key that put a kept proposal ahead of the overlapping proposal it displaced.
 *
 * `"tie"` means the two ranked equal and the kept one came first in the input.
 */
export type ProposalOverlapRule = "confidence" | "shorterSpan" | "earlierStart" | "tie"

/**
 * One proposal {@link resolveProposalOverlaps} dropped, the kept proposal it overlapped,
 * and the rule that kept that one.
 */
export interface ProposalOverlapDecision {
	kept: ClassificationProposal
	dropped: ClassificationProposal
	rule: ProposalOverlapRule
}

function spanLength(proposal: ClassificationProposal): number {
	return proposal.span.end - proposal.span.start
}

function overlapRule(kept: ClassificationProposal, dropped: ClassificationProposal): ProposalOverlapRule {
	if (kept.confidence !== dropped.confidence) return "confidence"

	if (spanLength(kept) !== spanLength(dropped)) return "shorterSpan"

	if (kept.span.start !== dropped.span.start) return "earlierStart"

	return "tie"
}

/**
 * Selects non-overlapping proposals and returns them in span order.
 * The input array is left unchanged.
 *
 * Proposals are ranked by higher confidence, then shorter span, then earlier start.
 * A greedy pass keeps each proposal that overlaps none already kept.
 *
 * When `decisions` is given, each dropped proposal is appended to it with the first
 * kept proposal it overlapped and the ranking key that decided between them.
 */
export function resolveProposalOverlaps(
	proposals: readonly ClassificationProposal[],
	decisions?: ProposalOverlapDecision[]
): ClassificationProposal[] {
	if (proposals.length <= 1) return [...proposals]

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	const ranked = [...proposals].sort((a, b) => {
		if (b.confidence !== a.confidence) return b.confidence - a.confidence
		const lenA = spanLength(a)
		const lenB = spanLength(b)

		if (lenA !== lenB) return lenA - lenB

		return a.span.start - b.span.start
	})

	const kept: ClassificationProposal[] = []

	for (const proposal of ranked) {
		const blocker = kept.find((k) => spansOverlap(k.span, proposal.span))

		if (!blocker) {
			kept.push(proposal)
		} else if (decisions) {
			decisions.push({ kept: blocker, dropped: proposal, rule: overlapRule(blocker, proposal) })
		}
	}

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	return kept.sort((a, b) => a.span.start - b.span.start)
}
