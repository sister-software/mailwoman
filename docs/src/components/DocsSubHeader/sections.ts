// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * One docs sub-header section: an id that must match a sidebar id in `sidebars.ts`, and its display label.
 */
export interface DocsSectionDef {
	id: string
	label: string
}

/**
 * Top-level documentation sections.
 * Their ids must match the sidebar ids in `sidebars.ts`.
 */
export const DOCS_SECTIONS: readonly DocsSectionDef[] = [
	{ id: "product", label: "Product" },
	{ id: "solutions", label: "Solutions" },
	{ id: "developers", label: "Developers" },
	{ id: "resources", label: "Resources" },
	{ id: "about", label: "About" },
]
