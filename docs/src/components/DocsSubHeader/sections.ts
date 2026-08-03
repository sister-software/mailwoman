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

/**
 * Top-level documentation sections, in the order they appear in the sub-header. Kept in lockstep with the sidebar ids
 * in `sidebars.ts` — an id here with no sidebar renders nothing (`SectionLink` returns `null` when the target sidebar
 * has no entry link), so a door is added to both files at once or to neither.
 */
export const DOCS_SECTIONS: readonly DocsSectionDef[] = [
	{ id: "developers", label: "Developers" },
	{ id: "about", label: "About" },
]
