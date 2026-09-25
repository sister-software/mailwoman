/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Converts between classification proposals and address trees.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import type { AddressNode, AddressTree } from "#decoder/types"
import type { Span } from "#tokenization/index"
import type { ClassificationProposal, ClassificationProposalSource } from "#types/index"

/**
 * Builds a flat address tree with one root per proposal, sorted by start offset.
 *
 * The function does not rebuild containment, so every node has no children.
 */
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
 * Converts each tree node to a proposal in depth-first order.
 *
 * Each span is a plain object with `start`, `end` and `body`, so the tokenization module is not loaded.
 *
 * @param tree The parsed address tree.
 * @param source The source recorded on each proposal.
 * @param opts.sourceID A source ID that overrides each node's own ID.
 * @param opts.emits The component tags to convert.
 * All tags are converted when it is absent.
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
