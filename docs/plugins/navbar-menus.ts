/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the navbar's mega menus from the docs sidebars.
 *   Each sidebar category becomes a section in the menu's rail, and each document becomes a link with the first
 *   sentence of its frontmatter `description` under it, so a new page joins its menu when it joins its sidebar.
 */

import { readLocalTextFileSync } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import sidebars from "../sidebars.mts"

/**
 * A menu line longer than this is shortened to the last whole word and given an ellipsis.
 */
const MAX_DESCRIPTION_LENGTH = 110

/**
 * The sidebar entries this builder reads: a doc id, a doc, a link or a category.
 */
type SidebarItemConfig =
	| string
	| { type: "doc"; id: string }
	| { type: "link"; label: string; href: string }
	| { type: "category"; label: string; items: SidebarItemConfig[] }
	| { type: string }

interface MenuLink {
	label: string
	to?: string
	href?: string
	description?: string
}

interface MenuSection {
	label: string
	group?: string
	description?: string
	items: MenuLink[]
}

export interface SidebarMenuOptions {
	/**
	 * The navbar tab's label.
	 */
	label: string
	/**
	 * The rail heading over the sidebar's top-level categories.
	 * Nested categories sit under their parent's label instead.
	 */
	topGroup?: string
	/**
	 * The section name for documents that sit at the sidebar's top level, outside any category.
	 */
	looseLabel?: string
	/**
	 * A line beside each section's heading, by section label.
	 */
	descriptions?: Readonly<Record<string, string>>
	footer?: { label: string; to: string }
	featured?: { eyebrow?: string; title: string; body?: string; to: string; linkLabel?: string; image?: string }
}

const firstSentence = (text: string) => {
	const sentence = text.split(/(?<=[.!?])\s|\s—\s/)[0] ?? text

	if (sentence.length <= MAX_DESCRIPTION_LENGTH) return sentence

	return `${sentence.slice(0, sentence.lastIndexOf(" ", MAX_DESCRIPTION_LENGTH))}…`
}

/**
 * The scalar `key: value` lines of a page's frontmatter block.
 *
 * Docusaurus loads this file through jiti. jiti rejects `import.meta`,
 * which the fuller parser uses in the docs scripts.
 */
const frontmatter = (source: string) => {
	const fields = new Map<string, string>()
	const block = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? ""

	for (const match of block.matchAll(/^([\w-]+):\s*(.+)$/gm)) {
		fields.set(match[1]!, match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2"))
	}

	return fields
}

const readArticle = (articlesDir: string, id: string) => {
	for (const extension of [".mdx", ".md"]) {
		try {
			return readLocalTextFileSync(resolvePath(articlesDir, id + extension))
		} catch {
			// Try the next extension.
		}
	}

	throw new Error(`The sidebar names ${id}, which has no file under docs/articles`)
}

const docLink = (articlesDir: string, id: string): MenuLink => {
	const fields = frontmatter(readArticle(articlesDir, id))
	const description = fields.get("description")

	return {
		label: fields.get("sidebar_label") ?? fields.get("title") ?? id,
		to: `/docs/${id.replace(/\/index$/, "")}`,
		description: description ? firstSentence(description) : undefined,
	}
}

const isCategory = (item: SidebarItemConfig): item is Extract<SidebarItemConfig, { type: "category" }> =>
	typeof item === "object" && item.type === "category"

const itemLink = (articlesDir: string, item: SidebarItemConfig): MenuLink | null => {
	if (typeof item === "string") return docLink(articlesDir, item)

	if ("id" in item) return docLink(articlesDir, item.id)

	if ("href" in item) return { label: item.label, href: item.href }

	return null
}

/**
 * Returns the builder for one sidebar's mega menu, as a `custom-megaMenu` navbar item.
 *
 * `siteDir` is the docs workspace.
 * It contains `articles/`.
 */
export const createSidebarMegaMenu = (siteDir: string) => (sidebarID: string, options: SidebarMenuOptions) => {
	const articlesDir = resolvePath(siteDir, "articles").toString()
	const sidebar = (sidebars as Record<string, unknown>)[sidebarID]

	if (!Array.isArray(sidebar)) throw new Error(`No sidebar named ${sidebarID}`)

	const sections: MenuSection[] = []
	const loose: MenuLink[] = []

	const addCategory = (label: string, items: readonly SidebarItemConfig[], group?: string) => {
		const links: MenuLink[] = []

		for (const item of items) {
			if (isCategory(item)) {
				addCategory(item.label, item.items, label)
			} else {
				const link = itemLink(articlesDir, item)

				if (link) {
					links.push(link)
				}
			}
		}

		if (links.length) {
			sections.push({ label, group, description: options.descriptions?.[label], items: links })
		}
	}

	for (const item of sidebar as SidebarItemConfig[]) {
		if (isCategory(item)) {
			addCategory(item.label, item.items, options.topGroup)
		} else {
			const link = itemLink(articlesDir, item)

			if (link) {
				loose.push(link)
			}
		}
	}

	if (loose.length) {
		const label = options.looseLabel ?? options.label

		sections.push({ label, description: options.descriptions?.[label], items: loose })
	}

	return {
		type: "custom-megaMenu",
		position: "left" as const,
		label: options.label,
		sections,
		footer: options.footer,
		featured: options.featured,
	}
}
