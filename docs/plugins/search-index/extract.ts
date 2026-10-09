/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads one built docs page into search records. A heading starts a record, a table row is a level-5
 *   record whose text is its first cell, and paragraph and list text joins the record of the heading above it.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { HIERARCHY_DEPTH, type SearchRecord } from "@mailwoman/react/search/types"
import { type AnyNode, type Document, type Element, isTag, isText } from "domhandler"
import { findAll, findOne, getAttributeValue } from "domutils"
import { parseDocument } from "htmlparser2"

const DEFAULT_CATEGORY = "Documentation"
const HEADING = /^h([1-6])$/
const TABLE_ROW_LEVEL = 5

/**
 * Zero-width and byte-order characters.
 * Docusaurus's heading anchors hold one as their text.
 */
const ZERO_WIDTH = /​|‌|‍|﻿/g

function hasClass(element: Element, name: string): boolean {
	return (getAttributeValue(element, "class") ?? "").split(/\s+/).includes(name)
}

/**
 * Whether an element's text belongs to a control or a popup rather than to the page.
 *
 * A glossary term's tooltip repeats the definition beside the term.
 * A heading's hash link holds only a zero-width space.
 */
function isAside(element: Element): boolean {
	return getAttributeValue(element, "role") === "tooltip" || hasClass(element, "hash-link")
}

function visibleText(node: AnyNode): string {
	if (isText(node)) return node.data

	if (!isTag(node) || isAside(node)) return ""

	return node.children.map(visibleText).join("")
}

function cleanText(element: Element): string {
	return visibleText(element).replaceAll(ZERO_WIDTH, "").replaceAll(/\s+/g, " ").trim()
}

/**
 * A row becomes its own record only when its first cell holds a name rather than a number or a mark.
 */
function namesRow(firstCell: string): boolean {
	return /\p{L}/u.test(firstCell)
}

function insideTableRow(element: Element): boolean {
	for (let parent = element.parent; parent; parent = parent.parent) {
		if ("name" in parent && parent.name === "tr") return true
	}

	return false
}

function category(document: Document): string {
	const active = findAll(
		(element) =>
			(hasClass(element, "menu__link--sublist") && hasClass(element, "menu__link--active")) ||
			hasClass(element, "navbar__link--active"),
		document.children
	)

	const last = active.at(-1)

	return (last && cleanText(last)) || DEFAULT_CATEGORY
}

function isNoIndex(document: Document): boolean {
	return findAll(
		(element) => element.name === "meta" && getAttributeValue(element, "name") === "robots",
		document.children
	).some((meta) => (getAttributeValue(meta, "content") ?? "").includes("noindex"))
}

interface Draft {
	anchor: string
	hierarchy: (string | null)[]
	level: number
	parts: string[]
}

export function extractRecords(html: string, url: string): SearchRecord[] {
	const document = parseDocument(html)
	const article = findOne((element) => element.name === "article", document.children)

	if (!article || isNoIndex(document)) return []

	const hierarchy: (string | null)[] = Array.from({ length: HIERARCHY_DEPTH }, () => null)

	hierarchy[0] = category(document)

	const drafts: Draft[] = []
	let anchor = ""
	let section: Draft | null = null

	const elements = findAll(
		(element) => HEADING.test(element.name) || element.name === "tr" || element.name === "p" || element.name === "li",
		article.children
	)

	for (const element of elements) {
		const heading = HEADING.exec(element.name)

		if (heading) {
			const level = Number(heading[1])

			hierarchy[level] = cleanText(element)
			hierarchy.fill(null, level + 1)
			anchor = level === 1 ? "" : (getAttributeValue(element, "id") ?? anchor)
			section = { anchor, hierarchy: [...hierarchy], level, parts: [] }
			drafts.push(section)
		} else if (element.name === "tr") {
			const cells = findAll((cell) => cell.name === "td", element.children)
			const first = cells[0]
			const last = cells.at(-1)

			if (!first || !last) continue

			const name = cleanText(first)

			// A row keyed by a number or a mark joins the section's text instead of standing as a hit.
			if (!namesRow(name)) {
				const text = cells
					.map(cleanText)
					.filter((cell) => cell !== "")
					.join(" ")

				if (section && text !== "") {
					section.parts.push(text)
				}

				continue
			}

			const rowHierarchy = [...hierarchy]

			rowHierarchy[TABLE_ROW_LEVEL] = name
			rowHierarchy.fill(null, TABLE_ROW_LEVEL + 1)

			drafts.push({
				anchor,
				hierarchy: rowHierarchy,
				level: TABLE_ROW_LEVEL,
				parts: cells.length > 1 ? [cleanText(last)] : [],
			})
		} else if (section) {
			// A list item that holds a paragraph would add the same text twice.
			if (element.name === "li" && findOne((child) => child.name === "p", element.children)) continue

			// Text inside a table cell belongs to the row's record.
			if (insideTableRow(element)) continue

			const text = cleanText(element)

			if (text !== "") {
				section.parts.push(text)
			}
		}
	}

	return drafts.map((draft, position) => ({
		id: sha256Hex(`${url}#${draft.anchor}\n${position}`).slice(0, 32),
		url,
		anchor: draft.anchor,
		hierarchy: draft.hierarchy,
		content: draft.parts.join(" "),
		level: draft.level,
		position,
	}))
}
