/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structural-validity checker for the decoded `AddressTree` — v0.7 task #37.
 *
 *   The postcode-only harness scores an address as "pass" on exact component match, but a parse can
 *   match a component and still be STRUCTURALLY incoherent — e.g. a `house_number` or
 *   `street_suffix` floating with no `street` anywhere, an `attention` with no `venue`. These
 *   orphan fragments are the signature of the overconfident hallucinations the v0.6.x cycle fought.
 *   This checker lifts the harness from "address-level pass" to "address-level pass AND
 *   structurally valid."
 *
 *   Two checks:
 *
 *   1. **illegal-edge** — invariant: a non-root node's parent tag must appear in its `PARENT_OF` list.
 *        (The tree builder enforces this by construction; the check guards against regressions in
 *        build-tree.ts.)
 *   2. **stranded-dependent** — a STRICT dependent tag (one that is meaningless without a structural
 *        anchor) whose anchor type is entirely ABSENT from the tree. Geographic containers
 *        (postcode / locality / region / street / venue / po_box) are deliberately NOT checked: a
 *        postcode-only or city-only input is a degenerate-but-valid parse, not a violation.
 */

import type { ComponentTag } from "../types/component.ts"
import { containmentFor } from "./containment.ts"
import type { AddressNode, AddressTree } from "./types.ts"

/**
 * Tags that cannot stand alone: each is a sub-component of a specific structural anchor (street / locality / venue /
 * postcode). If none of a tag's allowed parents appear anywhere in the tree, the node is an orphan fragment.
 */
const STRICT_DEPENDENTS: ReadonlySet<ComponentTag> = new Set<ComponentTag>([
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
	"house_number",
	"unit",
	"dependent_locality",
	"attention",
	"cedex",
	"intersection_a",
	"intersection_b",
])

export interface TreeViolation {
	type: "illegal-edge" | "stranded-dependent"
	tag: ComponentTag
	value: string
	detail: string
}

export interface TreeValidity {
	valid: boolean
	violations: TreeViolation[]
}

/** Validate an `AddressTree`'s structural coherence. See module docstring. */
export function validateTree(tree: AddressTree): TreeValidity {
	const violations: TreeViolation[] = []
	// Validate against the tree's own addressing system's hierarchy (defaults to Western).
	const parentOf = containmentFor(tree.system)

	const present = new Set<ComponentTag>()
	const collect = (n: AddressNode): void => {
		present.add(n.tag)
		n.children.forEach(collect)
	}
	tree.roots.forEach(collect)

	const walk = (node: AddressNode, parent: AddressNode | null): void => {
		const allowed = parentOf[node.tag]

		// 1. Edge invariant.
		if (parent && (!allowed || !allowed.includes(parent.tag))) {
			violations.push({
				type: "illegal-edge",
				tag: node.tag,
				value: node.value,
				detail: `${node.tag} nested under ${parent.tag}; allowed parents: [${(allowed ?? []).join(", ")}]`,
			})
		}

		// 2. Stranded strict-dependent.
		if (STRICT_DEPENDENTS.has(node.tag) && allowed && !allowed.some((t) => present.has(t))) {
			violations.push({
				type: "stranded-dependent",
				tag: node.tag,
				value: node.value,
				detail: `${node.tag} has no anchor (none of [${allowed.join(", ")}] present in the parse)`,
			})
		}

		node.children.forEach((c) => walk(c, node))
	}
	tree.roots.forEach((r) => walk(r, null))

	return { valid: violations.length === 0, violations }
}
