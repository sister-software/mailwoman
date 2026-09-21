/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Backticked repository paths in markdown, resolved against the filesystem.
 *
 *   The sibling class to `./links.ts`. A prose sentence names a file far more often in an inline code span —
 *   `packages/core/lib/fs/writers.ts` — than in a markdown link, and that spelling is the one a move leaves behind:
 *   nothing resolves it, so it keeps naming a file that is no longer there while reading exactly like a citation that
 *   works.
 *
 *   The instrument is the hard part rather than the census. A naive regex over backticked strings containing a slash counts
 *   things that were never claims about a file on disk, and a count dominated by those measures the regex. So a
 *   citation is refused — excluded before it can be counted broken — whenever its own text says it is not a path:
 *   {@linkcode refusalFor} names each class and the reason, and a finding is only ever a citation that survived all of
 *   them. The residual is reported with the refusals beside it so the ratio is visible rather than asserted.
 */

// Node builtins on purpose.
// `check/docs-structure.ts` reaches this file, and the Docs workflow runs it
// before `yarn install`, so no workspace specifier can resolve.
/* oxlint-disable typescript/no-restricted-imports -- runs before `yarn install`; see above */
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
/* oxlint-enable typescript/no-restricted-imports */

import { pathExists } from "./exists.ts"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * The docs package root, truncated at the `scripts/` segment rather than counted upward,
 * so moving this file to a different depth still resolves.
 *
 * Same rule as `./links.ts`'s `DOCS_ROOT`.
 */
const DOCS_ROOT = SCRIPT_DIR.slice(0, SCRIPT_DIR.lastIndexOf(`${path.sep}scripts${path.sep}`))

/**
 * The repository's top-level directories a citation may be rooted at.
 *
 * A path is recognized by its first segment rather than by shape, because the
 * shape alone cannot separate a repository file from a package subpath specifier
 * (`mailwoman/gazetteer-pipeline`), a URL tail, or a wire key.
 * Everything outside this set is not a citation this check makes a claim about.
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
 * Path segments whose contents are generated rather than tracked.
 *
 * A checkout that has not run `tsc -b` has no `out/`, and a docs command quoted
 * in a tutorial legitimately names one.
 * Resolving those against the filesystem measures whether the checkout is built,
 * which is a different question.
 */
const GENERATED_SEGMENTS = new Set([".docusaurus", ".yarn", "build", "dist", "node_modules", "out"])

/**
 * An inline code span, single or double backtick rather than spanning a line.
 */
const CODE_SPAN = /(`{1,2})([^`\n]+?)\1/g

/**
 * A filename that opens with an ISO date, which is how this tree marks a point-in-time record.
 */
const DATED_FILENAME = /(^|\/)\d{4}-\d{2}-\d{2}[-.]/

/**
 * Trees whose documents are point-in-time records although their filenames
 * carry no date, each with the reason.
 *
 * A record states what was true when it was written, so a path it names is evidence
 * rather than a claim about the current tree.
 * The same exemption `agents.md` gives dated records from the acronym-casing
 * convention and the banned vocabulary.
 *
 * This declares a class of document rather than a list of broken citations: a new stale path
 * inside one of these trees is still out of scope, and a new one outside them still fails.
 */
const RECORD_TREES = new Map([
	// `agents.md`: "The old implementation plan (`plan/readme.mdx`) and the phase directory
	// are historical design records — rationale rather than current state."
	["docs/records/plan/", "the superseded implementation plan"],
	["docs/records/retrospectives/", "retrospectives, written about a campaign that has ended"],
	// The inventories the same campaign produced, each a snapshot of the tree at its phase.
	["docs/superpowers/inventory/", "phase inventories of the tree as it stood"],
	// Deliberately defective prose, kept so `config/vale/check-rules.ts` has something to fail on.
	["config/vale/fixtures/", "fixtures for the prose-rule tests"],
])

/**
 * Whether `file` — repository-relative — is a point-in-time record rather than a living document.
 */
export function isPointInTimeRecord(file: string): boolean {
	if (DATED_FILENAME.test(file)) return true

	for (const prefix of RECORD_TREES.keys()) {
		if (file.startsWith(prefix)) return true
	}

	return false
}

/**
 * Why a candidate was not resolved.
 *
 * Each value is a class of text that looks like a path and is not a claim that one exists.
 */
export const CitationRefusal = {
	/**
	 * The first segment is not a repository directory, so the text is not a repository path.
	 */
	NotRepositoryRooted: "not-repository-rooted",
	/**
	 * An ellipsis stands in for segments the author left out (`corpus-python/.../configs/v1.8.0.yaml`).
	 */
	Elided: "elided",
	/**
	 * A glob, a `<placeholder>`, a `{brace}` or a `$variable` — a pattern over paths rather than one path.
	 */
	Pattern: "pattern",
	/**
	 * The path names generated output (`out/`, `dist/`, `node_modules/`),
	 * so its absence describes the checkout.
	 */
	Generated: "generated",
	/**
	 * The text carries a space, a `|`, or another shell character, so it is a command line rather than a path.
	 */
	NotAPath: "not-a-path",
	/**
	 * The citing document is a point-in-time record, so it names the tree as it was.
	 */
	Record: "record",
} as const

export type CitationRefusal = (typeof CitationRefusal)[keyof typeof CitationRefusal]

/**
 * One backticked citation whose target does not exist.
 */
export interface BrokenCitation {
	/**
	 * The file holding the citation, relative to the repository root.
	 */
	file: string
	/**
	 * The path exactly as written, with any position suffix removed.
	 */
	target: string
	/**
	 * 1-indexed line the citation sits on.
	 */
	line: number
}

/**
 * The refusal count per class, beside the number of citations actually resolved.
 */
export interface CitationCensus {
	/**
	 * Citations whose target resolved to a file or a directory.
	 */
	resolved: number
	/**
	 * Candidates refused before resolution, keyed by {@linkcode CitationRefusal}.
	 */
	refused: Record<CitationRefusal, number>
	/**
	 * The citations that resolved to nothing.
	 */
	broken: BrokenCitation[]
}

/**
 * The reason `text` is not a resolvable repository path, or null when it is one.
 *
 * Order matters only for reporting: a candidate hits at most one class in practice,
 * and the cheapest tests run first.
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
 * The path a citation claims, with a trailing position and any `#anchor` removed and a trailing slash kept.
 *
 * A position suffix names a place inside the file — `:129`, `:129:4`, or the `:129-131`
 * range a review comment quotes — and an anchor names a heading inside it.
 * Neither changes which file must exist.
 */
export function citationTarget(text: string): string {
	return text.replace(/#.*$/, "").replace(/:\d+(?:[:-]\d+)*$/, "")
}

/**
 * Census the backticked repository paths in `files`, resolving each against `repoRoot`.
 *
 * Every citation is repository-rooted, so it resolves against the repository root
 * rather than the citing file's directory, which is what separates this from `./links.ts`
 * and is why the two cannot share a resolver.
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
