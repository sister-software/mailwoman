/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The docs sub-header's section list, in display order. Each `id` must match a sidebar id in `sidebars.ts`; the `label`
 * is the switcher's display text (the sidebars themselves no longer carry a section label, since they render their
 * contents at the top level). Destination URLs are resolved at runtime from each sidebar's entry link, so a doc rename
 * can't desync them.
 */
export interface DocsSectionDef {
	id: string
	label: string
}

export const DOCS_SECTIONS: readonly DocsSectionDef[] = [
	{ id: "startHere", label: "Start here" },
	{ id: "understanding", label: "Understanding Mailwoman" },
	{ id: "concepts", label: "Concept deep dives" },
	{ id: "recipes", label: "Recipes" },
	{ id: "plan", label: "Implementation plan 🧪" },
	{ id: "evals", label: "Eval reports" },
	{ id: "retrospectives", label: "Retrospectives" },
]
