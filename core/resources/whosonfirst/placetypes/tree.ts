/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PlacetypeRole } from "./definition.js"
import { Placetype } from "./Placetype.js"

/**
 * A node in the nested placetype tree produced by {@linkcode generatePlacetypeTree}.
 *
 * WOF placetypes form a DAG (a placetype can have multiple parents — `borough`, for example, is a direct child of both
 * `country` and `macroregion`), so a tree projection rooted at a single placetype can list the same descendant under
 * multiple branches. That repetition is expected.
 */
export interface PlacetypeTreeNode {
	name: string
	id: number
	role: PlacetypeRole
	children: PlacetypeTreeNode[]
}

/**
 * Build a nested tree of a placetype and its descendants, optionally filtered by role.
 *
 * The traversal mirrors {@linkcode Placetype.findChildren} — direct children only at each level, recursively. The
 * DAG-to-tree projection may repeat descendants under multiple parents; if you need each placetype to appear exactly
 * once, use {@linkcode Placetype.findDescendants} for a flat de-duplicated set instead.
 */
export function generatePlacetypeTree(placetype: Placetype, roles?: Iterable<PlacetypeRole> | null): PlacetypeTreeNode {
	const roleSet = roles ? new Set(roles) : null

	return buildNode(placetype, roleSet)
}

function buildNode(placetype: Placetype, roles: Set<PlacetypeRole> | null): PlacetypeTreeNode {
	const children = placetype.findChildren(roles).map((child) => buildNode(child, roles))

	return {
		name: placetype.name,
		id: placetype.id,
		role: placetype.role,
		children,
	}
}
