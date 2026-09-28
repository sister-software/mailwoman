/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structural-validity checker for the decoded `AddressTree`.
 *
 *   The postcode-only harness scores an address as a pass on exact component match, and a parse can
 *   match a component while remaining structurally incoherent. Examples are a `house_number` or
 *   `street_suffix` floating with no `street` anywhere, and an `attention` with no `venue`. This
 *   checker raises the harness from address-level pass to address-level pass plus structural
 *   validity.
 *
 *   Two checks:
 *
 *   1. illegal-edge. A non-root node's parent tag must appear in its `PARENT_OF` list. The tree
 *      builder enforces this by construction, and the check guards against regressions in
 *      build-tree.ts.
 *   2. stranded-dependent. A strict dependent tag, which is meaningless without a structural
 *      anchor, has no anchor type anywhere in the tree. The checker skips the geographic containers.
 *      A postcode-only or city-only input is a valid degenerate parse.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import { containmentFor } from "#decoder/containment"
import type { AddressNode, AddressTree } from "#decoder/types"

/**
 * Tags that cannot stand alone.
 *
 * Each is a sub-component of a structural anchor such as street, locality, venue, or postcode.
 *
 * A node is an orphan fragment when none of its allowed parents appear anywhere in the tree.
 * This set is the denominator of the stranded-dependent check, so a caller counting
 * which classes fire reads it here rather than re-listing the tags.
 */
export const STRICT_DEPENDENTS: ReadonlySet<ComponentTag> = new Set<ComponentTag>([
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
	"house_number",
	"unit",
	"dependent_locality",
	"attention",
	"cedex",
])

/*
 * `intersection_a` and `intersection_b` are deliberately absent from `STRICT_DEPENDENTS`,
 * for the same reason the geographic containers are exempt.
 *
 * `Main St and 5th Ave` is a bare intersection query, a valid degenerate parse
 * with no street or locality to anchor to.
 */

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

/**
 * Validate an `AddressTree`'s structural coherence.
 *
 * See module docstring.
 */
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

		if (parent && (!allowed || !allowed.includes(parent.tag))) {
			violations.push({
				type: "illegal-edge",
				tag: node.tag,
				value: node.value,
				detail: `${node.tag} nested under ${parent.tag}; allowed parents: [${(allowed ?? []).join(", ")}]`,
			})
		}

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
