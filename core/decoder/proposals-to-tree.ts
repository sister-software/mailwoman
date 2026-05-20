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

import type { ClassificationProposal, ComponentTag } from "../types/index.js"
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
