/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PlacetypeRole } from "./definition.js"
import { Placetype } from "./Placetype.js"

/**
 * Colors for placetype roles.
 */
export const PlacetypeRoleColor = {
	common: "#0066cc",
	common_optional: "#00cc66",
	optional: "#ffcc00",
} as const satisfies Record<PlacetypeRole, string>

/**
 * Generate a Mermaid flowchart markup for a placetype and its descendants.
 */
export function generateMermaidMarkup(placetype: Placetype, roles?: Iterable<PlacetypeRole>): string {
	const lines: string[] = [
		"---",
		"config:",
		"  flowchart:",
		"    defaultRenderer: elk",
		"---",
		"graph TD",
		"  linkStyle default stroke-width: 5",
		`  classDef common fill:${PlacetypeRoleColor.common},stroke:#004d99,color:white,font-weight:bold`,
		`  classDef common_optional fill:${PlacetypeRoleColor.common_optional},stroke:#009933,color:white,font-weight:bold`,
		`  classDef optional fill:${PlacetypeRoleColor.optional},stroke:#cca300,color:black,font-weight:bold`,
	]

	const descendants = placetype.findDescendants(roles)

	for (const [idx, descendant] of descendants.entries()) {
		lines.push(`  ${placetype.name} --> ${descendant.name}:::${descendant.role}`)
		lines.push(`  linkStyle ${idx} stroke:${PlacetypeRoleColor[descendant.role]}`)
	}

	for (const descendant of descendants) {
		const children = descendant.findChildren(roles)

		for (const child of children) {
			lines.push(`  ${descendant.name} --> ${child.name}:::${child.role}`)
		}
	}

	return lines.join("\n")
}
