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

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { runFile } from "@mailwoman/core/process"
import { dirname, resolvePath } from "path-ts"

import type { RepoContext } from "#check"
import { createMoveResolver } from "#move/resolution"
import type { ModuleMove, ModuleMovePlan, SpecifierRewrite } from "#move/types"

export interface ModuleMoveApplyOptions {
	/**
	 * Report the plan and touch nothing.
	 */
	dryRun?: boolean
}

export interface ModuleMoveResult {
	moves: ModuleMove[]
	rewrites: SpecifierRewrite[]
	/**
	 * Rewritten specifiers re-resolved to their target against the moved tree. Equal to `rewrites.length` on success; a
	 * shortfall throws rather than returning.
	 */
	verified: number
	dryRun: boolean
}

/**
 * Apply the specifier edits for one file, splicing from the end so no offset shifts under a later edit.
 */
async function rewriteFile(repoRoot: string, file: string, edits: readonly SpecifierRewrite[]): Promise<void> {
	const path = resolvePath(repoRoot, file)
	let text = await readLocalTextFile(path)

	for (const edit of [...edits].toSorted((a, b) => b.start - a.start)) {
		const literal = text.slice(edit.start, edit.end)
		const quote = literal[0] ?? '"'

		if (!literal.includes(edit.specifier)) {
			throw new Error(`${file}: ${JSON.stringify(edit.specifier)} is not at ${edit.start}–${edit.end} (${literal})`)
		}

		text = `${text.slice(0, edit.start)}${quote}${edit.replacement}${quote}${text.slice(edit.end)}`
	}

	await writeLocalTextFile(text, path)
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
		return { moves: plan.moves, rewrites: plan.rewrites, verified: 0, dryRun: true }
	}

	for (const move of plan.moves) {
		await makeDirectories(resolvePath(context.repoRoot, String(dirname(move.to))))
		await runFile("git", ["mv", move.from, move.to], { cwd: context.repoRoot, encoding: "utf8" })
	}

	const byFile = new Map<string, SpecifierRewrite[]>()

	for (const rewrite of plan.rewrites) {
		byFile.set(rewrite.file, [...(byFile.get(rewrite.file) ?? []), rewrite])
	}

	for (const [file, edits] of byFile) {
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

	return { moves: plan.moves, rewrites: plan.rewrites, verified: plan.rewrites.length, dryRun: false }
}
