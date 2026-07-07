/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { rgb } from "d3-color"
import { interpolateViridis } from "d3-scale-chromatic"

import { type PlacetypeRole, PlacetypeRoles } from "./definition.js"
import { Placetype } from "./Placetype.js"

/**
 * Mermaid's `classDef` parser uses commas to separate style properties, so an `rgb(r, g, b)` value (which
 * d3-scale-chromatic emits for several interpolators, e.g. `interpolateRainbow`, `interpolateTurbo`,
 * `interpolateSinebow`) breaks the parse. Convert any d3-color-recognised input to hex before embedding. `d3-color`
 * already handles hex/rgb/rgba/hsl/named inputs.
 */
function toMermaidColor(input: string): string {
	const parsed = rgb(input)

	return Number.isNaN(parsed.r) ? input : parsed.formatHex()
}

/**
 * Hand-tuned default colors for placetype roles. Used when no `interpolator` is passed to
 * {@linkcode generateMermaidMarkup}. Each entry pairs a fill with a darker stroke and a text color chosen for contrast
 * against the fill.
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
 * A color interpolator — compatible with d3-scale-chromatic's `interpolate*` functions (e.g. `interpolateViridis`,
 * `interpolateTurbo`). Receives `t ∈ [0, 1]` and returns a CSS color string.
 */
export type InterpolateColorCallback = (t: number) => string

export interface GenerateMermaidMarkupOptions {
	/** Restrict descendants to the given roles. Default: all roles. */
	roles?: Iterable<PlacetypeRole>
	/**
	 * Edge color interpolator. Each edge is colored by its child node's depth from the root: `t = (childDepth - 1) /
	 * (maxDepth - 1)`. This traces a smooth gradient along any lineage path (e.g. `planet → continent → country → …`) and
	 * gives a visual cue for how deep an edge sits in the tree.
	 *
	 * Defaults to d3-scale-chromatic's `interpolateViridis` — perceptually uniform and colorblind-friendly. Node
	 * fills/strokes are _not_ affected; they always use the hand-tuned {@linkcode PlacetypeRoleColor} palette, which
	 * carries more semantic weight than a sampled gradient for only three categorical role values.
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
 * Walk the (filtered) subtree once to determine the deepest reachable descendant. Mirrors the structure of the
 * emit-walk in {@linkcode generateMermaidMarkup} so the depths it computes line up with the edges that will be emitted.
 * Cycles in the DAG are guarded by the `visited` set.
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
 * Generate a Mermaid flowchart markup for a placetype and its descendants.
 *
 * The walk is a recursive `findChildren` traversal — every emitted edge is a real direct-parent → direct-child
 * relationship. WOF placetypes form a DAG (e.g. `borough` has both `country` and `macroregion` as parents), so a child
 * can legitimately appear on multiple edges; the `visited` set prevents the subtree below it from being re-emitted.
 *
 * Edges are colored by depth from the root via {@linkcode GenerateMermaidMarkupOptions.edgeInterpolator} (default:
 * viridis), so any lineage path traces a smooth gradient down the chart. Node fills always use the hand-tuned role
 * palette.
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
		// The root is never the target of an emitted edge, so declare it standalone so it picks
		// up the role classDef and renders alongside the others.
		`  ${placetype.name}:::${placetype.role}`,
	]

	// Pre-compute max depth once so every edge's `t` is consistent across the second pass.
	const maxDepth = measureMaxDepth(placetype, roles)

	const visited = new Set<string>()
	let edgeIdx = 0

	const walk = (node: Placetype, depth: number): void => {
		for (const child of node.findChildren(roles)) {
			const childDepth = depth + 1
			// Single-level case: nothing to interpolate across, sample mid-gradient.
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
