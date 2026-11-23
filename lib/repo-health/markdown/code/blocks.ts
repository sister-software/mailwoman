// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Selects the JavaScript and TypeScript code blocks of a page for linting.
 *
 *   A block qualifies when its info string starts with a language this module maps to a file extension.
 *   Add `fragment` after the language to keep a partial example out of the lint run.
 *
 *   A block the page leaves unclosed renders as text and is skipped too.
 *
 *   A `{{release.version}}` token stays in the text, because a TypeScript block can
 *   only hold one inside a string literal, where it parses.
 */

import { type Fence, pageLines, scanFences } from "../fences.ts"

/**
 * The file extension each fence language is linted as.
 */
const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
	js: "js",
	javascript: "js",
	jsx: "jsx",
	mjs: "mjs",
	ts: "ts",
	typescript: "ts",
	tsx: "tsx",
}

/**
 * The info-string word that marks a block as a partial example.
 */
const FRAGMENT_MARKER = "fragment"

/**
 * One fenced block the lint reads.
 */
export interface CodeBlock {
	/**
	 * The block's position among the page's lintable blocks, starting at 0.
	 */
	index: number
	/**
	 * The extension the block's text is written to, such as `ts`.
	 */
	extension: string
	/**
	 * The 1-based page line of the block's first content line.
	 */
	firstLine: number
	/**
	 * The 1-based page line of the block's last content line, one less than `firstLine` for an empty block.
	 */
	lastLine: number
	/**
	 * The whitespace removed from the start of each content line.
	 *
	 * The linter adds the indentation length to reported columns.
	 * A fix restores the indentation on each line.
	 */
	indent: string
	/**
	 * The block's content with the fence's indentation removed, ending in a newline.
	 */
	text: string
}

function lintExtension(fence: Fence): string | null {
	const [language = "", ...meta] = fence.info.split(/\s+/)
	const extension = LANGUAGE_EXTENSIONS[language.toLowerCase()]

	// A `file=` fence shows a snippet file, and oxlint lints that file in place.
	if (!extension || meta.includes(FRAGMENT_MARKER) || meta.some((word) => word.startsWith("file="))) return null

	return extension
}

/**
 * Returns every lintable fenced block in `source`, in page order.
 */
export function extractCodeBlocks(source: string): CodeBlock[] {
	const blocks: CodeBlock[] = []

	for (const fence of scanFences(pageLines(source))) {
		const extension = lintExtension(fence)

		if (!extension || fence.closeLine === null) continue

		blocks.push({
			index: blocks.length,
			extension,
			// The opener's 0-based index plus one is its page line, and the content starts on the next line.
			firstLine: fence.openLine + 2,
			// The closer's 0-based index is the page line of the content line before it.
			lastLine: fence.closeLine,
			indent: fence.indent,
			text: `${fence.body.join("\n")}\n`,
		})
	}

	return blocks
}

/**
 * Returns `source` with each block's content replaced by its entry in `replacements`, keyed by block index.
 *
 * Each replacement line takes back the fence's indentation, and a blank line stays blank.
 */
export function replaceCodeBlocks(source: string, replacements: ReadonlyMap<number, string>): string {
	const lines = pageLines(source)
	const blocks = extractCodeBlocks(source)

	// Later blocks are replaced first, so an earlier block's line numbers still hold when a fix changes the line count.
	for (const block of blocks.toReversed()) {
		const text = replacements.get(block.index)

		if (typeof text !== "string" || text === block.text) continue

		const body = text.replace(/\n$/, "")
		const replaced = body.length ? pageLines(body).map((line) => (line.length ? `${block.indent}${line}` : line)) : []

		lines.splice(block.firstLine - 1, block.lastLine - block.firstLine + 1, ...replaced)
	}

	return lines.join("\n")
}
