/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fail-closed cleanup primitives. Callers must supply the generated roots they are authorized to mutate; a path is
 *   never considered safe merely because it is not exactly the repository or workspace root.
 */

import type { Stats } from "node:fs"

import { isAbsolute, relative, resolvePath, sep, type PathBuilderLike } from "path-ts"

import { ResourceError } from "#errors/schema"
import { assertIsDirectory, assertIsFile, tryStat } from "#fs/readers/stat"
import { makeDirectories, removeDirectory, removeFile } from "#fs/writers"
import type { WorkspacePackages, WorkspacePackage } from "#module/workspace"

export interface CleanOptions {
	/**
	 * Generated directory roots the caller has authorized this operation to mutate.
	 */
	allowedRoots: readonly PathBuilderLike[]
	/**
	 * Validate and report the operation without changing the filesystem.
	 */
	dryRun?: boolean
	/**
	 * Optional metadata already read for the target.
	 */
	cachedStats?: Stats | null
}

function pathIsWithin(path: string, root: string): boolean {
	const fromRoot = relative(root, path)

	return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
}

/**
 * Assert that a path is equal to or below one of the caller's explicit generated roots.
 */
export function assertDirectoryIsUntracked(
	directoryPath: PathBuilderLike,
	allowedRoots: readonly PathBuilderLike[]
): void {
	const target = resolvePath(directoryPath)
	const roots = allowedRoots.map((root) => resolvePath(root))

	if (roots.some((root) => pathIsWithin(target, root))) {
		return
	}

	throw ResourceError.from(400, `Path is outside declared generated directories: ${target}`)
}

/**
 * Clean a directory and recreate it, or create it when absent.
 */
export async function cleanDirectory(directoryPath: PathBuilderLike, options: CleanOptions): Promise<void> {
	const target = resolvePath(directoryPath)

	assertDirectoryIsUntracked(target, options.allowedRoots)

	const stats = options.cachedStats === undefined ? await tryStat(target) : options.cachedStats

	if (!stats) {
		if (!options.dryRun) {
			await makeDirectories(target)
		}

		return
	}

	await assertIsDirectory(target, `Expected path to be a directory: ${target}`, stats)

	if (options.dryRun) {
		return
	}

	await removeDirectory(target, stats)
	await makeDirectories(target)
}

/**
 * Remove a file when present.
 */
export async function cleanFile(filePath: PathBuilderLike, options: CleanOptions): Promise<void> {
	const target = resolvePath(filePath)

	assertDirectoryIsUntracked(target, options.allowedRoots)

	const stats = options.cachedStats === undefined ? await tryStat(target) : options.cachedStats

	if (!stats) {
		return
	}

	await assertIsFile(target, `Expected path to be a file: ${target}`, stats)

	if (!options.dryRun) {
		await removeFile(target, stats)
	}
}

export interface WorkspaceCleanOptions {
	/**
	 * Validate the workspace cleanup without changing the filesystem.
	 */
	dryRun?: boolean
}

function workspaceCleanOptions(workspaces: WorkspacePackages, options: WorkspaceCleanOptions): CleanOptions {
	return { allowedRoots: workspaces.generatedDirectoryRoots, dryRun: options.dryRun }
}

/**
 * Clean one workspace's compiled TypeScript output.
 */
export function cleanCompiledArtifacts(
	workspaces: WorkspacePackages,
	packageName: WorkspacePackage,
	options: WorkspaceCleanOptions = {}
): Promise<void> {
	return cleanDirectory(workspaces.tsOutPathBuilder(packageName), workspaceCleanOptions(workspaces, options))
}

/**
 * Clean one workspace's distribution output.
 */
export function cleanDistributionArtifacts(
	workspaces: WorkspacePackages,
	packageName: WorkspacePackage,
	options: WorkspaceCleanOptions = {}
): Promise<void> {
	return cleanDirectory(workspaces.distPathBuilder(packageName), workspaceCleanOptions(workspaces, options))
}

/**
 * Clean one workspace's generated distribution subtree.
 */
export function cleanGeneratedArtifacts(
	workspaces: WorkspacePackages,
	packageName: WorkspacePackage,
	options: WorkspaceCleanOptions = {}
): Promise<void> {
	return cleanDirectory(
		workspaces.distPathBuilder(packageName, "generated"),
		workspaceCleanOptions(workspaces, options)
	)
}
