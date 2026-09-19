/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A quoted repository path naming a file that moved.
 *
 *   A moved file leaves two kinds of reference behind. The compiler reads one of them — an import specifier — and
 *   reports it. The other is a string: a registry entry, a `run:` block, a CLI flag default, a docstring, a
 *   provenance line written into a generated artifact. Nothing reads those until something runs, and each is read
 *   by code that treats absence as a negative answer rather than an error, so the failure is a well-formed wrong
 *   result rather than a crash. `mwops health fix prefix-directories` rewrites a moved file's references from
 *   other files and not a file's references to itself, so the tool built for this class shares the blind spot.
 *
 *   two tests, and the second is the one that makes IT usable. A literal must look like a repository path — first
 *   segment a repository directory, last segment carrying a file extension — and name a path this repository once
 *   tracked. The shape test alone reported 93 literals over this tree, almost all of them correct: a path a
 *   `.run.ts` writes does not exist until it runs, `packages/neural-weights-en-us/model.onnx` is materialized and
 *   deliberately uncommitted, and a symbol test plants `packages/foo/new.ts` as fixture data. Requiring the path
 *   to have existed once leaves 20 of those 93, and what remains is a reference to something real that moved —
 *   which is what the check is for. A typo naming a path that never existed is a different defect, and the tool
 *   reading it fails immediately rather than answering wrongly.
 *
 *   test sources are OUT OF scope. All 20 survivors are in tests OF the path machinery itself — the symbol
 *   index's fixtures, `manifest-targets`, `move/specifiers` — which necessarily name paths that no longer exist.
 *   A test plants trees, so a path there is fixture data as often as a reference, and the two are not separable
 *   by inspection.
 *
 *   what IT cannot SEE, stated because silence is otherwise read as a clean tree: a path assembled from segments,
 *   a path behind a variable, a template literal that interpolates, and a browser selector, which is not a path at
 *   all. Those are `yarn test`'s to catch.
 *
 *   The history read costs 205 ms over 4,398 commits, measured on this repository.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { movedAwayPaths } from "@mailwoman/core/git"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"
import { trackedSourcePaths } from "#tracked-sources"

/**
 * First segments that make a literal a repository path rather than a package specifier or a bare filename.
 * `mailwoman/gazetteer-pipeline` is a subpath export and belongs to none of them.
 */
const REPOSITORY_ROOTS = ["packages/", "docs/", "data/", "evals/", "corpus-python/", "docker/", "hf-publish/"]

/**
 * Dated records name paths as they were, by design.
 */
const SKIPPED_PREFIXES = ["docs/records/"]

/**
 * Segments marking derived output — absent on a clean checkout, present after a build. A literal naming one is
 * answering a question about the build rather than about a tracked file.
 */
const DERIVED_SEGMENTS = ["/out/", "/dist/", "/node_modules/", "/build/", "/.yarn/", "/coverage/"]

/**
 * A literal that is a repository path by shape. Rejects a glob, an interpolation placeholder, a URL, and anything
 * carrying whitespace — a sentence naming a directory is prose rather than a path.
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

export interface StalePathLiteral {
	file: string
	line: number
	literal: string
}

/**
 * Every quoted repository path in the tracked non-test TypeScript sources that names a path the tree once had and no
 * longer does.
 */
export async function findStalePathLiterals(context: {
	repoRoot: string
	trackedFiles: readonly string[]
}): Promise<StalePathLiteral[]> {
	const tracked = new Set(context.trackedFiles)

	// `existingOnly`: the index can name a file the working tree no longer has — a rename staged and not committed is
	// enough — and this walk opens every path it is given, so the absent one throws enoent and the check fails for a
	// reason that has nothing to do with path literals. `tracked` above keeps the full index, because a literal naming a
	// staged-for-deletion file is still a literal naming a tracked file.
	const sources = (await trackedSourcePaths(context, { existingOnly: true }))
		.map((path) => relative(context.repoRoot, path))
		.filter((file) => !/\/test\/|\.test\.tsx?$/u.test(file))

	const moved = await movedAwayPaths(context.repoRoot)
	const stale: StalePathLiteral[] = []

	for (const file of sources) {
		const text = await readLocalTextFile(resolvePath(context.repoRoot, file))

		// Cheap reject before parsing: most files name no repository path at all.
		if (!REPOSITORY_ROOTS.some((root) => text.includes(root))) continue

		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
		const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1

		const visit = (node: ts.Node): void => {
			// A no-substitution template literal resolves exactly as a quoted string does. one with substitutions
			// cannot be resolved and is out of this check's reach by construction.
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
 * The `stale-path-literals` check: one error per quoted repository path naming a file that moved.
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
