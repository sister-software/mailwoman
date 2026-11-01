/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module classifies the lines a commit added to data files. A vocabulary sweep that rewrites a key or value
 *   in a data file changes a stored string, and the compiler and tests can pass while every reader of that string
 *   breaks. The classification separates comment lines from key and value lines so a reviewer reads only the second
 *   group.
 */

import { TextSpliterator } from "spliterator"

/**
 * Extensions whose contents a program reads as data.
 */
export const DATA_EXTENSIONS: ReadonlySet<string> = new Set([
	"json",
	"jsonl",
	"yaml",
	"yml",
	"csv",
	"tsv",
	"ini",
	"toml",
	"ksy",
])

/**
 * The extension of a path, or an empty string when the basename has no dot.
 */
export function extensionOf(path: string): string {
	const basename = path.slice(path.lastIndexOf("/") + 1)
	const dot = basename.lastIndexOf(".")

	return dot > 0 ? basename.slice(dot + 1).toLowerCase() : ""
}

/**
 * Whether a line is a comment in the syntax its file uses.
 *
 * JSON, JSONL, CSV and TSV have no comment syntax, so every line in those files is a key or a value.
 */
export function isDataComment(extension: string, line: string): boolean {
	const trimmed = line.trim()

	switch (extension) {
		case "yaml":
		case "yml":
		case "toml":
		case "ksy":
			return trimmed.startsWith("#")
		case "ini":
			return trimmed.startsWith("#") || trimmed.startsWith(";")
		default:
			return false
	}
}

/**
 * The destination path of a `git show --numstat` entry.
 *
 * Git writes a rename as `old => new` or `dir/{old => new}/file`.
 */
export function numstatDestination(path: string): string {
	const braced = path.match(/^(.*)\{[^{}]* => ([^{}]*)\}(.*)$/u)

	if (braced) return `${braced[1]}${braced[2]}${braced[3]}`.replaceAll("//", "/")

	const arrow = path.indexOf(" => ")

	return arrow !== -1 ? path.slice(arrow + 4) : path
}

/**
 * The added lines of one data file, split into comment lines and key or value lines.
 */
export interface DataDiffReport {
	path: string
	commentLines: number
	valueLines: string[]
}

/**
 * Classifies the added lines of a unified diff for one data file.
 *
 * Blank added lines are dropped.
 */
export function classifyDataDiff(path: string, diff: string): DataDiffReport {
	const extension = extensionOf(path)
	const report: DataDiffReport = { path, commentLines: 0, valueLines: [] }

	for (const line of TextSpliterator.from(diff)) {
		if (!line.startsWith("+") || line.startsWith("+++")) continue

		const content = line.slice(1)

		if (!content.trim()) continue

		if (isDataComment(extension, content)) {
			report.commentLines += 1
		} else {
			report.valueLines.push(content.trim())
		}
	}

	return report
}
