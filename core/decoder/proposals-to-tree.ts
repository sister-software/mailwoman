/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Project a flat list of `ClassificationProposal`s into a flat `AddressTree` (every proposal
 *   becomes a root node, no containment nesting). Useful for surfacing policy-filtered output
 *   through the existing JSON/tuple/XML decoder projections without rebuilding the original
 *   containment hierarchy — which is intentionally lossy: once proposals are individually
 *   accept/rejected by policy, the containment relationships from the source tree may no longer be
 *   meaningful.
 *
 *   For consumers that need containment back, re-tokenize the input and run the full decoder
 *   pipeline.
 */

import type { Span } from "../tokenization/index.js"
import type { ClassificationProposal, ClassificationProposalSource, ComponentTag } from "../types/index.js"
import type { AddressNode, AddressTree } from "./types.js"

export function proposalsToTree(raw: string, proposals: readonly ClassificationProposal[]): AddressTree {
	const roots: AddressNode[] = proposals.map((p) => ({
		tag: p.component as ComponentTag,
		value: p.span.body,
		start: p.span.start,
		end: p.span.end,
		confidence: p.confidence,
		children: [],
		source: p.source,
		sourceId: p.source_id,
	}))
	roots.sort((a, b) => a.start - b.start)
	return { raw, roots }
}

/**
 * The inverse of {@link proposalsToTree}: walk an `AddressTree` into a flat list of
 * `ClassificationProposal`s (one per node, depth-first), tagged with the given `source` (#478
 * increment 3). Used to bring the whole-text neural parse into the arbitration layer's proposal
 * currency so it can be unioned with rule proposals and filtered by the policy registry.
 *
 * The spans are structural (`{ start, end, body }`) — we intentionally avoid `Span.from(...)`
 * (which forces the tokenization module's filesystem-bound init); downstream proposal consumers
 * read only `start` / `end` / `body`. Same convention as the neural proposal-classifier adapter.
 *
 * @param tree The parsed tree (e.g. the neural argmax tree).
 * @param source Provenance stamped on every emitted proposal (`"neural"` here).
 * @param opts.sourceId Optional stable id surfaced as `source_id`.
 * @param opts.emits Optional tag allow-list; when set, only nodes with these tags are emitted.
 */
export function treeToProposals(
	tree: AddressTree,
	source: ClassificationProposalSource,
	opts: { sourceId?: string; emits?: ReadonlySet<ComponentTag> } = {}
): ClassificationProposal[] {
	const proposals: ClassificationProposal[] = []
	const { sourceId, emits } = opts

	const visit = (node: AddressNode): void => {
		if (!emits || emits.has(node.tag)) {
			const span = { start: node.start, end: node.end, body: node.value } as unknown as Span
			proposals.push({
				span,
				component: node.tag,
				confidence: node.confidence,
				source,
				source_id: sourceId ?? node.sourceId ?? source,
				penalty: 0,
			})
		}
		for (const child of node.children) visit(child)
	}

	for (const root of tree.roots) visit(root)
	return proposals
}
