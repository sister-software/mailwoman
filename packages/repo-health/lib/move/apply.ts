/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Applies a module move plan to the checkout and re-resolves every rewritten specifier against the real tree.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePath, removePathIfPresent, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"
import { dirname, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { RepoContext } from "#check"
import { emittedMoves } from "#move/literals"
import { createMoveResolver } from "#move/resolution"
import { spliceText, type TextEdit } from "#move/splice"
import type { ManifestRewrite, ModuleMove, ModuleMovePlan, PathLiteralRewrite, SpecifierRewrite } from "#move/types"

/**
 * Options for {@linkcode applyModuleMoves}.
 */
export interface ModuleMoveApplyOptions {
	/**
	 * When true, the call returns the plan without changing any file.
	 */
	dryRun?: boolean
}

/**
 * The outcome of {@linkcode applyModuleMoves}.
 */
export interface ModuleMoveResult {
	moves: ModuleMove[]
	rewrites: SpecifierRewrite[]
	manifestRewrites: ManifestRewrite[]
	pathLiterals: PathLiteralRewrite[]
	/**
	 * The count of rewritten specifiers that resolve to their target in the moved tree.
	 *
	 * It equals `rewrites.length` on success, because any shortfall throws.
	 */
	verified: number
	dryRun: boolean
}

/**
 * Groups every text edit in the plan by the file it applies to.
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
 * Removes each source directory the moves emptied, and each parent that becomes empty with it.
 *
 * `git mv` leaves the emptied directory on disk.
 * An existence check would otherwise still find the old path.
 */
async function removeEmptiedDirectories(repoRoot: string, directories: readonly string[]): Promise<void> {
	for (const directory of new Set(directories)) {
		let current = directory

		while (current.includes("/")) {
			const path = resolvePath(repoRoot, current)

			if (!(await pathExists(path))) break

			if (await Globerator.from("*", { cwd: path, absolute: false, onlyFiles: false }).some(() => true)) break

			await removePath(path)
			current = dirname(current)
		}
	}
}

/**
 * Deletes the build output each moved source used to emit.
 *
 * `tsc -b --clean` skips output whose source is gone, so a stale module from the old
 * tree would otherwise survive every rebuild and still load.
 */
async function removeOrphanedOutput(repoRoot: string, moves: readonly ModuleMove[]): Promise<void> {
	for (const move of emittedMoves(moves)) {
		if (move.from === move.to) continue

		await removePathIfPresent(resolvePath(repoRoot, move.from))
	}
}

async function rewriteFile(repoRoot: string, file: string, edits: readonly TextEdit[]): Promise<void> {
	const path = resolvePath(repoRoot, file)
	const text = await readLocalTextFile(path)

	await writeLocalTextFile(spliceText(file, text, edits), path)
}

/**
 * Moves the files with `git mv`, rewrites the planned specifiers, manifest targets
 * and path literals, and then re-resolves each rewritten specifier.
 *
 * The function throws before touching anything when the plan has an unresolved specifier.
 * After the move, it throws when a rewritten specifier resolves elsewhere
 * or a rewritten manifest source target is missing.
 * Recovery from a failed move is `git checkout`.
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
		await makeDirectories(resolvePath(context.repoRoot, dirname(move.to)))
		await runFile("git", ["mv", move.from, move.to], { cwd: context.repoRoot, encoding: "utf8" })
	}

	await removeEmptiedDirectories(
		context.repoRoot,
		plan.moves.map((move) => dirname(move.from))
	)

	await removeOrphanedOutput(context.repoRoot, plan.moves)

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

		// The build has not emitted `out/` targets yet, so only source targets can be checked.
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
