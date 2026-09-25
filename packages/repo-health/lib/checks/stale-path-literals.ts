/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reports quoted repository paths in source that refer to a file that has moved.
 *
 *   The compiler catches a stale import specifier, but a path in a string is read only at run time, and the code that
 *   reads it often treats a missing file as a valid negative answer.
 *
 *   A literal is reported when it has the shape of a repository path and git history shows that the repository once
 *   tracked it. The history test excludes paths that a script writes, uncommitted build artifacts and fixture paths.
 *   Test sources are skipped because they plant fixture trees. The check cannot see a path assembled from segments,
 *   held in a variable, or built by an interpolating template literal.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { movedAwayPaths } from "@mailwoman/core/git"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * The first segments that mark a literal as a repository path instead of a package specifier.
 */
const REPOSITORY_ROOTS = ["packages/", "docs/", "data/", "evals/", "corpus-python/", "docker/", "hf-publish/"]

/**
 * Path prefixes that the check skips.
 * Dated records keep the paths as they were when written.
 */
const SKIPPED_PREFIXES = ["docs/records/"]

/**
 * Path segments that mark build output, which a clean checkout lacks.
 */
const DERIVED_SEGMENTS = ["/out/", "/dist/", "/node_modules/", "/build/", "/.yarn/", "/coverage/"]

/**
 * Returns whether a literal has the shape of a repository path.
 *
 * It rejects globs, interpolation placeholders, URLs, whitespace, skipped prefixes and build output.
 * The last segment must carry a file extension.
 */
export function isRepositoryPathLiteral(text: string): boolean {
	if (!REPOSITORY_ROOTS.some((root) => text.startsWith(root))) return false

	if (/[*?\s${}<>|"'`]/u.test(text)) return false

	if (text.includes("://")) return false

	if (SKIPPED_PREFIXES.some((prefix) => text.startsWith(prefix))) return false

	if (DERIVED_SEGMENTS.some((segment) => text.includes(segment))) return false

	const last = text.slice(text.lastIndexOf("/") + 1)

	return /\.[a-z0-9]{1,8}$/iu.test(last) && !last.endsWith(".tsbuildinfo")
}

/**
 * One stale path literal and its location.
 */
export interface StalePathLiteral {
	file: string
	line: number
	literal: string
}

/**
 * Returns every quoted repository path in tracked non-test TypeScript sources
 * that the tree once tracked and no longer does.
 */
export async function findStalePathLiterals(context: {
	repoRoot: string
	trackedFiles: readonly string[]
}): Promise<StalePathLiteral[]> {
	const tracked = new Set(context.trackedFiles)

	// The index can list a file that the working tree lacks, such as after an uncommitted rename.
	// The walk reads every path, so `existingOnly` prevents an ENOENT failure.
	// `tracked` keeps the full index, because a file staged for deletion is still tracked.
	const sources = (await trackedSourcePaths(context, { existingOnly: true }))
		.map((path) => relative(context.repoRoot, path))
		.filter((file) => !/\/test\/|\.test\.tsx?$/u.test(file))

	const moved = await movedAwayPaths(context.repoRoot)
	const stale: StalePathLiteral[] = []

	for (const file of sources) {
		const text = await readLocalTextFile(resolvePath(context.repoRoot, file))

		// Most files contain no repository path, so a text search skips them before parsing.
		if (!REPOSITORY_ROOTS.some((root) => text.includes(root))) continue

		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
		const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1

		const visit = (node: ts.Node): void => {
			// A template literal without substitutions has a fixed value, so the check treats it as a string.
			if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
				const literal = node.text

				if (isRepositoryPathLiteral(literal) && !tracked.has(literal) && moved.has(literal)) {
					stale.push({ file, line: lineOf(node.getStart(source)), literal })
				}
			}

			node.forEachChild(visit)
		}

		source.forEachChild(visit)
	}

	return stale
}

/**
 * The `stale-path-literals` check.
 * It reports one error for each stale path literal.
 */
export const stalePathLiteralsCheck: RepoCheck = {
	id: "stale-path-literals",
	description: "No quoted repository path names a file this tree once tracked and no longer has.",
	async run(context) {
		const stale = await findStalePathLiterals(context)

		return stale.map((entry): Diagnostic => ({
			severity: DiagnosticSeverity.Error,
			message: `"${entry.literal}" was tracked once and is gone — a moved file leaves this kind of reference behind, and the code reading it treats absence as an answer rather than an error`,
			file: entry.file,
			line: entry.line,
		}))
	},
}
