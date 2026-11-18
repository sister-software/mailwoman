// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Finds the fenced code blocks of a Markdown or MDX page.
 *
 *   A fence opens with a run of three or more backticks or tildes, indented by any amount of
 *   whitespace, and closes at a line holding only a run of the same character at least as long.
 *   A shorter run, or a run of the other character, is content of the open block.
 */

import { TextSpliterator } from "spliterator"

/**
 * An opening or closing fence: indentation, the fence run, and the info string.
 */
const FENCE_LINE = /^(?<indent>[ \t]*)(?<run>`{3,}|~{3,})(?<info>.*)$/

/**
 * One fenced block of a page.
 */
export interface Fence {
	/**
	 * The info string after the opening run, trimmed, such as `ts title=example.ts`.
	 */
	info: string
	/**
	 * The whitespace before the opening run, removed from each content line that starts with it.
	 */
	indent: string
	/**
	 * The 0-based line index of the opening fence.
	 */
	openLine: number
	/**
	 * The 0-based line index of the closing fence, or `null` when the page ends inside the block.
	 */
	closeLine: number | null
	/**
	 * The content lines between the fences, with the opening fence's indentation removed.
	 */
	body: string[]
}

/**
 * Splits `source` into lines with blank lines and leading whitespace kept,
 * so a line index matches the page's line number minus one.
 */
export function pageLines(source: string): string[] {
	return TextSpliterator.from(source, { trim: false, skipEmpty: false }).toArray()
}

function stripIndent(line: string, indent: string): string {
	return line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()
}

/**
 * Returns every fenced block of `lines`, in page order.
 */
export function scanFences(lines: readonly string[]): Fence[] {
	const fences: Fence[] = []
	let open: (Fence & { run: string }) | null = null

	for (const [index, line] of lines.entries()) {
		const groups = FENCE_LINE.exec(line)?.groups

		if (!open) {
			if (!groups) continue

			open = {
				info: groups.info!.trim(),
				indent: groups.indent!,
				openLine: index,
				closeLine: null,
				body: [],
				run: groups.run!,
			}

			continue
		}

		const run = groups?.run
		const closes = run && !groups.info!.trim() && run[0] === open.run[0] && run.length >= open.run.length

		if (!closes) {
			open.body.push(stripIndent(line, open.indent))

			continue
		}

		const { run: _run, ...fence } = open

		fences.push({ ...fence, closeLine: index })
		open = null
	}

	if (open) {
		const { run: _run, ...fence } = open

		fences.push(fence)
	}

	return fences
}

/**
 * Returns the 0-based indexes of every line inside or on a fence, so a prose check can skip them.
 *
 * A block left open at the end of the page covers every line after its opener.
 */
export function fencedLineIndexes(lines: readonly string[]): Set<number> {
	const fenced = new Set<number>()

	for (const fence of scanFences(lines)) {
		const last = fence.closeLine ?? lines.length - 1

		for (let index = fence.openLine; index <= last; index++) {
			fenced.add(index)
		}
	}

	return fenced
}
