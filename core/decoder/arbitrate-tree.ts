/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Containment-preserving arbitration (#478 inc 3, fix-v1).
 *
 *   The first arbitration implementation flattened the neural parse to proposals, unioned the solved
 *   v0 proposals, filtered per-component, resolved span overlaps, and rebuilt a FLAT tree. That
 *   lost containment two ways (diagnosed in `2026-06-17-478-arbitration-arena-gate.md`): the
 *   overlap pass evicted a `street` for the `street_suffix` sitting inside it (street dropped on
 *   42% of rows), and the flat tree lost the region→locality structure the resolver needs
 *   (wrong-state namesakes, coord p50 3.3 km → 1069 km).
 *
 *   This applies arbitration as **edits on the nested neural argmax tree** — never flattening, never
 *   restructuring — so the neural tree's containment is preserved by construction. Used only on the
 *   `rule_preferred` route; `neural_preferred` / `abstain` pass the neural tree through untouched.
 *
 *   The edits (DeepSeek-coordinated, 2026-06-17):
 *
 *   1. **Relabel** — when a rule proposal covers the EXACT span of a neural node but assigns a different
 *        tag, take the rule's tag (the genuine same-span disagreement; rule wins under
 *        `rule_preferred`). Structure unchanged — only the node's tag/provenance.
 *   2. **Add missing tags** — a rule proposal whose tag is absent from the neural tree AND whose span
 *        doesn't overlap any neural node is added as a new root (a component neural missed
 *        entirely).
 *
 *   What it deliberately does NOT do: replace a neural node with a differently-spanned rule node,
 *   drop neural's sub-component decomposition (`street_suffix`/`street_prefix`), or add an
 *   overlapping rule node. So a clean address — where neural and v0 agree on tags+spans and differ
 *   only in street decomposition — is a **no-op**. The cost is losing pure-decomposition wins (low
 *   value); the gate re-run is the arbiter.
 */

import type { ClassificationProposal } from "../types/index.js"
import type { AddressNode, AddressTree } from "./types.js"

function cloneNode(node: AddressNode): AddressNode {
	return { ...node, children: node.children.map(cloneNode) }
}

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	return aStart < bEnd && bStart < aEnd
}

/**
 * Edit the nested neural argmax tree with the solved v0 (rule) parse under the `rule_preferred` route — relabel
 * same-span tag disagreements toward rule, add rule-only non-overlapping missing tags. Containment-preserving (no
 * flatten, no restructure). Input is not mutated.
 *
 * @param tree The neural argmax `AddressTree`.
 * @param ruleProposals Proposals from the solved v0 parse (`solutionToProposals`).
 */
export function applyRuleArbitration(tree: AddressTree, ruleProposals: readonly ClassificationProposal[]): AddressTree {
	const roots = tree.roots.map(cloneNode)

	// 1. Relabel: a rule proposal on the EXACT span of a neural node, but a different tag → rule's tag.
	const relabel = (node: AddressNode): void => {
		const hit = ruleProposals.find(
			(p) => p.span.start === node.start && p.span.end === node.end && p.component !== node.tag
		)

		if (hit) {
			node.tag = hit.component
			node.source = "rule"
			node.confidence = hit.confidence
			node.sourceID = hit.source_id
		}

		for (const child of node.children) {
			relabel(child)
		}
	}

	for (const root of roots) {
		relabel(root)
	}

	// Post-relabel inventory: which tags exist, and every node span (for the overlap guard).
	const neuralTags = new Set<string>()
	const neuralSpans: Array<{ start: number; end: number }> = []
	const collect = (node: AddressNode): void => {
		neuralTags.add(node.tag)
		neuralSpans.push({ start: node.start, end: node.end })

		for (const child of node.children) {
			collect(child)
		}
	}

	for (const root of roots) {
		collect(root)
	}

	// 2. Add: a rule tag the neural tree lacks entirely, on a span that overlaps no neural node.
	for (const p of ruleProposals) {
		if (neuralTags.has(p.component)) continue

		if (neuralSpans.some((s) => spansOverlap(s.start, s.end, p.span.start, p.span.end))) continue
		roots.push({
			tag: p.component,
			value: p.span.body,
			start: p.span.start,
			end: p.span.end,
			confidence: p.confidence,
			children: [],
			source: p.source,
			sourceID: p.source_id,
		})
		neuralTags.add(p.component) // a tag is added at most once
		neuralSpans.push({ start: p.span.start, end: p.span.end })
	}

	roots.sort((a, b) => a.start - b.start)

	return { ...tree, roots }
}
