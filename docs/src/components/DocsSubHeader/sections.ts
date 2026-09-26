/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * One docs sub-header section: an id that must match a sidebar id in `sidebars.ts`, and its display label.
 */
export interface DocsSectionDef {
	id: string
	label: string
}

/**
 * Top-level documentation sections, whose ids must match sidebar ids in `sidebars.ts`.
 */
export const DOCS_SECTIONS: readonly DocsSectionDef[] = [
	{ id: "product", label: "Product" },
	{ id: "solutions", label: "Solutions" },
	{ id: "developers", label: "Developers" },
	{ id: "resources", label: "Resources" },
	{ id: "about", label: "About" },
]
