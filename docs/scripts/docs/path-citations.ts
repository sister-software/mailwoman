/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Finds repository paths in markdown inline code spans that do not exist on disk.
 *
 *   Many backticked strings that contain a slash are not file paths. {@linkcode refusalFor} sorts those into refusal
 *   classes before resolution, and the census reports the refusal counts beside the broken citations.
 */

// The Docs workflow runs `check/docs-structure.ts`, which imports this file, before `yarn install`.
// Only Node builtins can resolve at that point.
/* oxlint-disable typescript/no-restricted-imports -- runs before `yarn install`; see above */
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
/* oxlint-enable typescript/no-restricted-imports */

import { pathExists } from "./exists.ts"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * The docs package root.
 *
 * It is the part of this file's path before the last `scripts/` segment,
 * so it stays correct if this file moves to another depth.
 */
const DOCS_ROOT = SCRIPT_DIR.slice(0, SCRIPT_DIR.lastIndexOf(`${path.sep}scripts${path.sep}`))

/**
 * The top-level repository directories that a citation can start with.
 *
 * A citation is recognized by its first segment, because a package subpath such as
 * `mailwoman/gazetteer-pipeline` has the same shape as a repository path.
 */
const REPOSITORY_ROOTS = new Set([
	".claude",
	".codex",
	".github",
	"corpus-python",
	"data",
	"docker",
	"docs",
	"evals",
	"hf-publish",
	"packages",
])

/**
 * Path segments that hold generated output.
 *
 * Whether such a path exists depends on whether the checkout has been built,
 * so these citations are refused.
 */
const GENERATED_SEGMENTS = new Set([".docusaurus", ".yarn", "build", "dist", "node_modules", "out"])

/**
 * This pattern matches a single- or double-backtick code span on one line.
 */
const CODE_SPAN = /(`{1,2})([^`\n]+?)\1/g

/**
 * This pattern matches a filename that starts with an ISO date, which marks a point-in-time record.
 */
const DATED_FILENAME = /(^|\/)\d{4}-\d{2}-\d{2}[-.]/

/**
 * Directories whose documents are point-in-time records even though their filenames have no date.
 * Each entry maps the directory prefix to the reason.
 *
 * A record describes the tree as it was when written, so its broken paths are counted as refusals.
 */
const RECORD_TREES = new Map([
	["docs/records/plan/", "the superseded implementation plan"],
	["docs/records/retrospectives/", "retrospectives, written about a campaign that has ended"],
	["docs/superpowers/inventory/", "phase inventories of the tree as it stood"],
	["config/vale/fixtures/", "fixtures for the prose-rule tests"],
])

/**
 * Return whether a repository-relative `file` is a point-in-time record.
 */
export function isPointInTimeRecord(file: string): boolean {
	if (DATED_FILENAME.test(file)) return true

	for (const prefix of RECORD_TREES.keys()) {
		if (file.startsWith(prefix)) return true
	}

	return false
}

/**
 * The reasons a path-like code span is excluded from resolution.
 */
export const CitationRefusal = {
	/**
	 * The first segment is outside `REPOSITORY_ROOTS`, or the text has only one segment.
	 */
	NotRepositoryRooted: "not-repository-rooted",
	/**
	 * An ellipsis replaces omitted segments (`corpus-python/.../configs/v1.8.0.yaml`).
	 */
	Elided: "elided",
	/**
	 * The text contains a glob, a `<placeholder>`, a `{brace}` or a `$variable`.
	 */
	Pattern: "pattern",
	/**
	 * The path passes through generated output such as `out/`, `dist/` or `node_modules/`.
	 */
	Generated: "generated",
	/**
	 * The text contains whitespace or a `|`, which marks a command line.
	 */
	NotAPath: "not-a-path",
	/**
	 * The citing document is a point-in-time record, and the path did not resolve.
	 */
	Record: "record",
} as const

/**
 * One of the refusal values in {@linkcode CitationRefusal}.
 */
export type CitationRefusal = (typeof CitationRefusal)[keyof typeof CitationRefusal]

/**
 * A backticked citation whose target does not exist.
 */
export interface BrokenCitation {
	/**
	 * The file that contains the citation, relative to the repository root.
	 */
	file: string
	/**
	 * The path as written, without its position suffix or anchor.
	 */
	target: string
	/**
	 * The 1-based line where the citation starts.
	 */
	line: number
}

/**
 * The census result: resolved citations, refusals by class, and broken citations.
 */
export interface CitationCensus {
	/**
	 * The number of citations that resolved to a file or directory.
	 */
	resolved: number
	/**
	 * The number of refused candidates for each {@linkcode CitationRefusal}.
	 */
	refused: Record<CitationRefusal, number>
	/**
	 * The citations that resolved to no target.
	 */
	broken: BrokenCitation[]
}

/**
 * Return the refusal class for `text`, or null when it should be resolved as a repository path.
 */
export function refusalFor(text: string): CitationRefusal | null {
	if (/[\s|<>{}$*?]/.test(text)) {
		return /[<>{}$*?]/.test(text) ? CitationRefusal.Pattern : CitationRefusal.NotAPath
	}

	if (text.includes("...") || text.includes("…")) return CitationRefusal.Elided

	const segments = text.split("/")

	if (!REPOSITORY_ROOTS.has(segments[0]!)) return CitationRefusal.NotRepositoryRooted

	if (segments.length < 2) return CitationRefusal.NotRepositoryRooted

	if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) return CitationRefusal.Generated

	return null
}

/**
 * Return the file path of a citation after removing any `#anchor` and position suffix.
 *
 * Position suffixes take the forms `:129`, `:129:4` and `:129-131`.
 * A trailing slash is kept.
 */
export function citationTarget(text: string): string {
	return text.replace(/#.*$/, "").replace(/:\d+(?:[:-]\d+)*$/, "")
}

/**
 * Count the backticked repository paths in `files` and resolve each against `repoRoot`.
 *
 * Citations resolve against the repository root.
 * Markdown links in `./links.ts` resolve against the citing file's directory.
 */
export async function censusPathCitations(
	files: string[],
	repoRoot: string = path.dirname(DOCS_ROOT)
): Promise<CitationCensus> {
	const census: CitationCensus = {
		resolved: 0,
		refused: {
			[CitationRefusal.NotRepositoryRooted]: 0,
			[CitationRefusal.Elided]: 0,
			[CitationRefusal.Pattern]: 0,
			[CitationRefusal.Generated]: 0,
			[CitationRefusal.NotAPath]: 0,
			[CitationRefusal.Record]: 0,
		},
		broken: [],
	}

	for (const file of files) {
		const relativeFile = path.relative(repoRoot, file)
		const isRecord = isPointInTimeRecord(relativeFile)
		const text = await readFile(file, "utf8")
		const lineStarts: number[] = [0]

		for (let index = 0; index < text.length; index++) {
			if (text[index] === "\n") {
				lineStarts.push(index + 1)
			}
		}

		for (const match of text.matchAll(CODE_SPAN)) {
			const spanText = match[2]!.trim()

			if (!spanText.includes("/")) continue

			const refusal = refusalFor(spanText)

			if (refusal) {
				census.refused[refusal]++

				continue
			}

			const target = citationTarget(spanText)

			if (await pathExists(path.resolve(repoRoot, target))) {
				census.resolved++

				continue
			}

			if (isRecord) {
				census.refused[CitationRefusal.Record]++

				continue
			}

			let line = 1

			while (line < lineStarts.length && lineStarts[line]! <= match.index) {
				line++
			}

			census.broken.push({ file: relativeFile, target, line })
		}
	}

	return census
}
