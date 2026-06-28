/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coherence pass for arbitrated proposals (#478 increment 3).
 *
 *   The arbitration layer unions proposals from multiple sources (whole-text `neural`, per-section
 *   `rule`) and filters them per-component via the policy registry. That per-_tag_ filter is blind
 *   to cross-_tag_ span overlap: a `neural` street span `[0,11]` ("350 5th Ave") and a `rule`
 *   house_number `[0,3]` ("350") can both survive — different tags, overlapping spans. Fed straight
 *   into {@link proposalsToTree} (which emits one flat root node per proposal, no overlap handling)
 *   that yields an incoherent tree with overlapping nodes, which degrades or breaks the resolver.
 *
 *   This pass guarantees the invariant {@link proposalsToTree} needs: **no two surviving proposals
 *   have overlapping spans.** It is a greedy interval selection — accept proposals in priority
 *   order, skip any that overlap an already-accepted span.
 *
 *   ## The selection policy (the gate-tunable lever)
 *
 *   Priority is **confidence desc, then shorter span first, then earlier start**:
 *
 *   - _Confidence primary_ respects the arbitration that already happened — a source the registry kept
 *       at high confidence wins its span.
 *   - _Shorter-span-first on ties_ preserves finer decompositions: given equal-confidence
 *       `street[0,11]` vs `{house_number[0,3], street[4,11]}`, the two finer spans are accepted and
 *       the coarse subsuming span is dropped — keeping the street+house_number precondition intact
 *       (the thing #566 broke). The neural argmax path labels per-token, so it normally emits the
 *       finer decomposition itself; this tiebreak is the safety net when a coarse rule span
 *       competes.
 *
 *   This policy is deliberately simple and deterministic. It is the lever the inc-3 assembled gate
 *   validates: if it drops too many house numbers (precondition regression) the comparator is where
 *   to look. (An alternative — earliest-end-first maximal-tiling, ignoring confidence — maximizes
 *   the _count_ of non-overlapping spans but can let a spurious tiny span evict a correct large
 *   one; confidence-primary guards against that.)
 *
 *   Pure module: reads only `span.{start,end}` + `confidence`. Safe to import anywhere.
 */

import type { ClassificationProposal } from "../types/index.js"

/** Half-open interval overlap: `[aStart,aEnd)` and `[bStart,bEnd)` share at least one position. */
function spansOverlap(a: ClassificationProposal["span"], b: ClassificationProposal["span"]): boolean {
	return a.start < b.end && b.start < a.end
}

/**
 * Reduce a set of (possibly overlapping) arbitrated proposals to a coherent, non-overlapping set via greedy interval
 * selection. The output is sorted by span start (the order {@link proposalsToTree} expects). Input is not mutated.
 *
 * @param proposals Arbitrated proposals (post policy-registry filter), any source, possibly overlapping.
 *
 * @returns A subset with no two spans overlapping, in span-start order.
 */
export function resolveProposalOverlaps(proposals: readonly ClassificationProposal[]): ClassificationProposal[] {
	if (proposals.length <= 1) return [...proposals]

	const ranked = [...proposals].sort((a, b) => {
		if (b.confidence !== a.confidence) return b.confidence - a.confidence // higher confidence first
		const lenA = a.span.end - a.span.start
		const lenB = b.span.end - b.span.start

		if (lenA !== lenB) return lenA - lenB

		// shorter (finer) span first — preserve decompositions
		return a.span.start - b.span.start // earlier start first — stable, deterministic
	})

	const kept: ClassificationProposal[] = []

	for (const proposal of ranked) {
		if (kept.every((k) => !spansOverlap(k.span, proposal.span))) {
			kept.push(proposal)
		}
	}

	return kept.sort((a, b) => a.span.start - b.span.start)
}
