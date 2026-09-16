/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The comment inventory as an operation over a repo context, so `mwops` can run it the way it runs a check.
 *
 *   `inventorySourceComments` takes a file list; this decides WHICH files and where the database goes, which is the
 *   half a caller would otherwise re-derive. The CLI beside it is a thin adapter over this.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { dirname, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { RepoContext } from "#check"
import { inventorySourceComments, type InventoryResult } from "#comment/triage/index"

/**
 * Where the inventory lands when a caller names no path. Under `.cache/` because it is rebuilt from the tree on every
 * run and nothing reads it across checkouts.
 */
export const DEFAULT_TRIAGE_DATABASE = ".cache/mailwoman/comment-triage.sqlite"

/**
 * The inventory's own report: what it wrote and how much of the tree it read.
 */
export interface TriageInventoryReport extends InventoryResult {
	databasePath: string
	files: number
}

/**
 * The tracked TypeScript and Python source a comment inventory reads.
 *
 * `.d.ts` carries generated declarations and `out/` the compiled tree, so both would inventory comments this repository
 * did not write and cannot edit.
 */
function isInventorySource(path: string): boolean {
	const isPython = path.startsWith("corpus-python/") && path.endsWith(".py")

	if (!isPython && !path.endsWith(".ts") && !path.endsWith(".tsx")) return false

	if (path.endsWith(".d.ts")) return false

	return !/(?:^|\/)(?:out|node_modules)\//u.test(path)
}

/**
 * Inventory every tracked source comment into a SQLite database, with the heuristic review leads beside them.
 */
export async function runCommentInventory(
	context: RepoContext,
	databasePath: string = DEFAULT_TRIAGE_DATABASE
): Promise<TriageInventoryReport> {
	const resolved = resolvePath(context.repoRoot, databasePath)

	const discovered = new Set(
		await Globerator.files(["ts", "tsx", "py"], {
			cwd: context.repoRoot,
			absolute: false,
			throwIfDirectoryMissing: false,
		}).toArray()
	)

	const files = context.trackedFiles.filter((path) => discovered.has(path) && isInventorySource(path))

	await makeDirectories(dirname(resolved))

	const result = await inventorySourceComments(resolved, context.repoRoot, files)

	return { databasePath: resolved.toString(), files: files.length, ...result }
}
