/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writing a planned move to the checkout: rename the files, splice the specifiers, then re-resolve every
 *   specifier that was written.
 *
 *   The plan proved each replacement against an overlay — a filesystem where the move had already happened. This pass
 *   asks the real one the same question, because an overlay is a model and a model can be wrong about the thing it
 *   models. A mismatch throws with the surviving edits named: the tree is a git checkout, so the recovery is `git
 *   checkout` plus a re-read, and that is a better outcome than a silent half-move.
 *
 *   `git mv` rather than a rename, so the index carries the rename and a reviewer reads a moved file rather than a
 *   deletion beside an addition.
 */

import { pathExists, readDirectory, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePath, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"
import { dirname, resolvePath } from "path-ts"

import type { RepoContext } from "#check"
import { createMoveResolver } from "#move/resolution"
import { spliceText, type TextEdit } from "#move/splice"
import type { ManifestRewrite, ModuleMove, ModuleMovePlan, PathLiteralRewrite, SpecifierRewrite } from "#move/types"

export interface ModuleMoveApplyOptions {
	/**
	 * Report the plan and touch nothing.
	 */
	dryRun?: boolean
}

export interface ModuleMoveResult {
	moves: ModuleMove[]
	rewrites: SpecifierRewrite[]
	manifestRewrites: ManifestRewrite[]
	pathLiterals: PathLiteralRewrite[]
	/**
	 * Rewritten specifiers re-resolved to their target against the moved tree. Equal to `rewrites.length` on success; a
	 * shortfall throws rather than returning.
	 */
	verified: number
	dryRun: boolean
}

/**
 * Every edit the plan makes to a file's text, by file: a module specifier in a source file, a subpath target in a
 * manifest.
 */
function editsByFile(plan: ModuleMovePlan): Map<string, TextEdit[]> {
	const byFile = new Map<string, TextEdit[]>()

	const record = (file: string, edit: TextEdit): void => {
		byFile.set(file, [...(byFile.get(file) ?? []), edit])
	}

	for (const rewrite of plan.rewrites) {
		record(rewrite.file, { ...rewrite, expected: rewrite.specifier, quoted: true })
	}

	for (const rewrite of plan.manifestRewrites) {
		record(rewrite.file, { ...rewrite, expected: rewrite.target, quoted: true })
	}

	for (const rewrite of plan.pathLiterals) {
		record(rewrite.file, { ...rewrite, expected: rewrite.path, quoted: false })
	}

	return byFile
}

/**
 * Remove each source directory the moves emptied, and each parent that empties with it.
 *
 * `git mv` moves files and leaves the directory standing, so a checkout keeps an empty `sub-venue/` next to the new
 * `sub/venue/`. Git does not track it, which is worse than harmless: it makes the old layout look like it survived, and
 * it is what an existence check reads when asking whether a path still means anything.
 */
async function removeEmptiedDirectories(repoRoot: string, directories: readonly string[]): Promise<void> {
	for (const directory of new Set(directories)) {
		let current = directory

		while (current.includes("/")) {
			const path = resolvePath(repoRoot, current)

			if (!(await pathExists(path))) break

			if ((await readDirectory(path)).length) break

			await removePath(path)
			current = String(dirname(current))
		}
	}
}

async function rewriteFile(repoRoot: string, file: string, edits: readonly TextEdit[]): Promise<void> {
	const path = resolvePath(repoRoot, file)
	const text = await readLocalTextFile(path)

	await writeLocalTextFile(spliceText(file, text, edits), path)
}

/**
 * Move the files and rewrite the specifiers `plan` names.
 *
 * A plan carrying an unresolved specifier is refused outright: it describes a tree that would not resolve, and applying
 * the part of it that does resolve leaves the remainder harder to find, not easier.
 */
export async function applyModuleMoves(
	context: RepoContext,
	plan: ModuleMovePlan,
	options: ModuleMoveApplyOptions = {}
): Promise<ModuleMoveResult> {
	if (plan.unresolved.length) {
		const listed = plan.unresolved.map((entry) => `${entry.file}: ${entry.specifier} — ${entry.reason}`).join("\n  ")

		throw new Error(`Refusing to move: ${plan.unresolved.length} specifier(s) have no proven replacement.\n  ${listed}`)
	}

	if (options.dryRun) {
		return {
			moves: plan.moves,
			rewrites: plan.rewrites,
			manifestRewrites: plan.manifestRewrites,
			pathLiterals: plan.pathLiterals,
			verified: 0,
			dryRun: true,
		}
	}

	for (const move of plan.moves) {
		await makeDirectories(resolvePath(context.repoRoot, String(dirname(move.to))))
		await runFile("git", ["mv", move.from, move.to], { cwd: context.repoRoot, encoding: "utf8" })
	}

	await removeEmptiedDirectories(
		context.repoRoot,
		plan.moves.map((move) => String(dirname(move.from)))
	)

	for (const [file, edits] of editsByFile(plan)) {
		await rewriteFile(context.repoRoot, file, edits)
	}

	const resolver = createMoveResolver(context.repoRoot, [])

	const wrong = plan.rewrites.filter(
		(rewrite) => resolver.resolve(rewrite.replacement, rewrite.file) !== rewrite.target
	)

	if (wrong.length) {
		const listed = wrong.map((rewrite) => `${rewrite.file}: ${rewrite.replacement} ≠ ${rewrite.target}`).join("\n  ")

		throw new Error(
			`Moved, but ${wrong.length} of ${plan.rewrites.length} rewritten specifiers do not resolve to their target. Recover with \`git checkout\` and re-read the plan.\n  ${listed}`
		)
	}

	const missing: string[] = []

	for (const rewrite of plan.manifestRewrites) {
		const directory = rewrite.file.slice(0, rewrite.file.lastIndexOf("/"))
		const target = `${directory}/${rewrite.replacement.slice(2)}`

		// An `out/` target names a file `tsc` has not emitted yet, so only a source target can be checked here.
		if (target.includes("/out/")) continue

		if (!(await pathExists(resolvePath(context.repoRoot, target)))) {
			missing.push(`${rewrite.file}: ${target}`)
		}
	}

	if (missing.length) {
		throw new Error(
			`Moved, but ${missing.length} rewritten manifest target(s) name a file that is not there.\n  ${missing.join("\n  ")}`
		)
	}

	return {
		moves: plan.moves,
		rewrites: plan.rewrites,
		manifestRewrites: plan.manifestRewrites,
		pathLiterals: plan.pathLiterals,
		verified: plan.rewrites.length,
		dryRun: false,
	}
}
