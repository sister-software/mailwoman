/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { rgb } from "d3-color"
import { interpolateViridis } from "d3-scale-chromatic"

import { type PlacetypeRole, PlacetypeRoles } from "#resources/whosonfirst/placetypes/definition"
import type { Placetype } from "#resources/whosonfirst/placetypes/Placetype"

/**
 * Mermaid's `classDef` parser separates style properties with commas, so an `rgb(r, g, b)`
 * value (emitted by several d3-scale-chromatic interpolators) breaks the parse
 * and must be converted to hex before embedding.
 */
function toMermaidColor(input: string): string {
	const parsed = rgb(input)

	return Number.isNaN(parsed.r) ? input : parsed.formatHex()
}

/**
 * Hand-tuned fill colors for placetype roles, paired with a darker stroke
 * and a text color chosen for contrast against the fill.
 */
export const PlacetypeRoleColor = {
	common: "#0066cc",
	common_optional: "#00cc66",
	optional: "#ffcc00",
} as const satisfies Record<PlacetypeRole, string>

const PlacetypeRoleStroke = {
	common: "#004d99",
	common_optional: "#009933",
	optional: "#cca300",
} as const satisfies Record<PlacetypeRole, string>

const PlacetypeRoleText = {
	common: "white",
	common_optional: "white",
	optional: "black",
} as const satisfies Record<PlacetypeRole, string>

/**
 * A color interpolator compatible with d3-scale-chromatic's `interpolate*` functions,
 * receiving `t ∈ [0, 1]` and returning a CSS color string.
 */
export type InterpolateColorCallback = (t: number) => string

export interface GenerateMermaidMarkupOptions {
	/**
	 * Restrict descendants to the given roles; defaults to all roles.
	 */
	roles?: Iterable<PlacetypeRole>
	/**
	 * Edge color interpolator, colored per edge by its child node's depth from
	 * the root as `t = (childDepth - 1) / (maxDepth - 1)` and defaulting to
	 * d3-scale-chromatic's `interpolateViridis`; node fills and strokes are unaffected
	 * and always use the hand-tuned {@linkcode PlacetypeRoleColor} palette.
	 */
	edgeInterpolator?: InterpolateColorCallback
}

interface RolePalette {
	fill: string
	stroke: string
	text: string
}

const HAND_TUNED_PALETTE: Record<PlacetypeRole, RolePalette> = Object.fromEntries(
	PlacetypeRoles.map((role) => [
		role,
		{ fill: PlacetypeRoleColor[role], stroke: PlacetypeRoleStroke[role], text: PlacetypeRoleText[role] },
	])
) as Record<PlacetypeRole, RolePalette>

/**
 * Walk the filtered subtree once to find the deepest reachable descendant, mirroring the emit-walk in
 * {@linkcode generateMermaidMarkup} so its depths line up with the edges that will be emitted.
 */
function measureMaxDepth(root: Placetype, roles: Iterable<PlacetypeRole> | undefined): number {
	let maxDepth = 0
	const visited = new Set<string>()

	const walk = (node: Placetype, depth: number): void => {
		for (const child of node.findChildren(roles)) {
			const childDepth = depth + 1

			if (childDepth > maxDepth) {
				maxDepth = childDepth
			}

			if (visited.has(child.name)) continue
			visited.add(child.name)
			walk(child, childDepth)
		}
	}

	walk(root, 0)

	return maxDepth
}

/**
 * Generate Mermaid flowchart markup for a placetype and its descendants, walking recursively
 * through `findChildren` and emitting only real direct-parent → direct-child edges;
 * WOF placetypes form a DAG, so a child can legitimately appear on multiple edges
 * while the `visited` set prevents re-emitting the subtree below it.
 */
export function generateMermaidMarkup(placetype: Placetype, options: GenerateMermaidMarkupOptions = {}): string {
	const { roles, edgeInterpolator = interpolateViridis } = options
	const palette = HAND_TUNED_PALETTE

	const lines: string[] = [
		"---",
		"config:",
		"  flowchart:",
		"    defaultRenderer: elk",
		"---",
		"graph TD",
		"  linkStyle default stroke-width: 5",
		...PlacetypeRoles.map(
			(role) =>
				`  classDef ${role} fill:${palette[role].fill},stroke:${palette[role].stroke},color:${palette[role].text},font-weight:bold`
		),
		// The root is never the target of an emitted edge, so declare it standalone to pick up the role classDef.
		`  ${placetype.name}:::${placetype.role}`,
	]

	// Pre-compute max depth once so every edge's `t` is consistent across the second pass.
	const maxDepth = measureMaxDepth(placetype, roles)

	const visited = new Set<string>()
	let edgeIdx = 0

	const walk = (node: Placetype, depth: number): void => {
		for (const child of node.findChildren(roles)) {
			const childDepth = depth + 1
			// Single-level case: no range to interpolate across, sample mid-gradient.
			const t = maxDepth > 1 ? (childDepth - 1) / (maxDepth - 1) : 0.5
			const edgeColor = toMermaidColor(edgeInterpolator(t))

			lines.push(`  ${node.name} --> ${child.name}:::${child.role}`)
			lines.push(`  linkStyle ${edgeIdx} stroke:${edgeColor}`)

			edgeIdx++

			if (visited.has(child.name)) continue
			visited.add(child.name)
			walk(child, childDepth)
		}
	}

	walk(placetype, 0)

	return lines.join("\n")
}
