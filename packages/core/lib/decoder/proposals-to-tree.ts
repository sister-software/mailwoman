/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convert classification proposals to a flat address tree. Each proposal becomes a root node;
 *   containment is not reconstructed.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import type { AddressNode, AddressTree } from "#decoder/types"
import type { Span } from "#tokenization/index"
import type { ClassificationProposal, ClassificationProposalSource } from "#types/index"

export function proposalsToTree(raw: string, proposals: readonly ClassificationProposal[]): AddressTree {
	const roots: AddressNode[] = proposals.map((p) => ({
		tag: p.component as ComponentTag,
		value: p.span.body,
		start: p.span.start,
		end: p.span.end,
		confidence: p.confidence,
		children: [],
		source: p.source,
		sourceID: p.source_id,
	}))

	roots.sort((a, b) => a.start - b.start)

	return { raw, roots }
}

/**
 * Convert each tree node to a proposal in depth-first order.
 *
 * Spans use the structural fields consumed downstream, avoiding tokenization-module initialization.
 *
 * @param tree Parsed address tree.
 * @param source Provenance assigned to each proposal.
 * @param opts.sourceID Optional stable source ID.
 * @param opts.emits Optional allowlist of component tags.
 */
export function treeToProposals(
	tree: AddressTree,
	source: ClassificationProposalSource,
	opts: { sourceID?: string; emits?: ReadonlySet<ComponentTag> } = {}
): ClassificationProposal[] {
	const proposals: ClassificationProposal[] = []
	const { sourceID, emits } = opts

	const visit = (node: AddressNode): void => {
		if (!emits || emits.has(node.tag)) {
			const span = { start: node.start, end: node.end, body: node.value } as Span

			proposals.push({
				span,
				component: node.tag,
				confidence: node.confidence,
				source,
				source_id: sourceID ?? node.sourceID ?? source,
				penalty: 0,
			})
		}

		for (const child of node.children) {
			visit(child)
		}
	}

	for (const root of tree.roots) {
		visit(root)
	}

	return proposals
}
