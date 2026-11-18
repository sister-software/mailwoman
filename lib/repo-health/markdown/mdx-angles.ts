// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reports prose that MDX parses as JSX and that fails the docs build.
 *
 *   Docusaurus compiles `.md` and `.mdx` pages through micromark's MDX extension.
 *   In prose, `<` before a digit opens a tag whose name can't start with a digit, as in `<55 ms`.
 *
 *   `{` before a letter opens a JavaScript expression, as in `{word}`, which fails when the page renders.
 *   Both stop the build.
 *
 *   A capitalized `<Component>` and a lowercase `<tag>` are valid MDX, so neither is reported.
 *
 *   Fenced code and inline code spans are skipped, because MDX reads their text literally.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { join } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

import { fencedLineIndexes, pageLines } from "./fences.ts"

/**
 * The trees Docusaurus compiles: the docs, the site pages and the research blog.
 */
const COMPILED_ROOTS = ["docs/articles/", "docs/src/pages/", "docs/research/"]

const PAGE_EXTENSION = /\.mdx?$/

/**
 * `<` before a digit, or `{` before a letter.
 */
const RAW_ANGLE = /<[0-9]|\{[a-zA-Z]/

/**
 * An inline code span: a run of backticks, its text, and a closing run of the same length.
 */
const INLINE_CODE = /(`+).*?\1/g

/**
 * One line of prose that MDX would parse as JSX.
 */
interface RawAngle {
	/**
	 * The 1-based page line.
	 */
	line: number
	text: string
}

/**
 * Returns every prose line of `source` that holds a raw `<` before a digit or `{` before a letter.
 */
export function findRawAngles(source: string): RawAngle[] {
	const lines = pageLines(source)
	const fenced = fencedLineIndexes(lines)
	const found: RawAngle[] = []

	for (const [index, text] of lines.entries()) {
		if (fenced.has(index)) continue

		if (RAW_ANGLE.test(text.replaceAll(INLINE_CODE, ""))) {
			found.push({ line: index + 1, text })
		}
	}

	return found
}

/**
 * The check reports each compiled docs page line that MDX would parse as JSX.
 */
export const mdxAnglesCheck: RepoCheck = {
	id: "mdx-angles",
	description:
		"No prose line in a compiled docs page holds `<` before a digit or `{` before a letter outside code, which MDX parses as JSX.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		const pages = context.trackedFiles.filter(
			(path) => PAGE_EXTENSION.test(path) && COMPILED_ROOTS.some((root) => path.startsWith(root))
		)

		for (const page of pages) {
			for (const { line, text } of findRawAngles(await readLocalTextFile(join(context.repoRoot, page)))) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message: `MDX parses this as JSX and the build fails; put it in backticks, spell it out, or escape the character: ${text.trim()}`,
					file: page,
					line,
					details: null,
				})
			}
		}

		return diagnostics
	},
}
