// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Whether a repository entry point runs on its own checkout's packages.
 *
 *   Node resolves a bare `@mailwoman/*` specifier by walking up parent directories to the first
 *   `node_modules` that holds it. A worktree under `.claude/worktrees/<name>` without its own install
 *   therefore resolves `@mailwoman/core` from the primary checkout above it, and a worktree whose
 *   `node_modules` links to the primary checkout's does the same. Every command then exits 0.
 *
 *   `repoRootPath` counts up from where `@mailwoman/core` was loaded.
 *   Every repository path then points into the other checkout.
 *   Health checks grade its files, `copy-weights` and the overlay linkers write into its workspaces,
 *   and a parse probe runs its compiled `out/`.
 *   This module compares the working tree holding the entry point with the working tree
 *   `@mailwoman/core` computed as the repository root.
 *
 *   Both sides are compared as canonical paths.
 *   The loaded side comes from `import.meta.url`, and Node and Vite report it after following symbolic links.
 *   The entry side is put through `realpath` as well.
 */

import { dirname, resolvePath, type PathBuilderLike } from "path-ts"

import { tryRealPath, tryStatLink } from "#fs/readers/stat"
import { repoRootPath } from "#paths"
import { CommandError } from "#scripting/command"

/**
 * What the entry checkout's `node_modules` entry is.
 */
export const NodeModulesState = {
	/**
	 * A directory of its own, as `yarn install` leaves it.
	 */
	Directory: "directory",
	/**
	 * A symbolic link, such as one to another checkout's install.
	 */
	Link: "link",
	/**
	 * No entry, so resolution continues in the parent directories.
	 */
	Absent: "absent",
} as const

export type NodeModulesState = (typeof NodeModulesState)[keyof typeof NodeModulesState]

export interface CheckoutLocality {
	/**
	 * The canonical working tree that holds the entry point.
	 */
	entryTree: string
	/**
	 * The canonical repository root `@mailwoman/core` computed from where it was loaded.
	 */
	loadedTree: string
	/**
	 * The entry tree's `node_modules` entry, with the canonical target of a link.
	 */
	nodeModules: { state: NodeModulesState; target: string | null }
	/**
	 * Whether the entry tree and the loaded tree are the same checkout.
	 */
	local: boolean
}

/**
 * The canonical working tree that contains `directory`: the nearest ancestor holding a `.git` entry.
 *
 * That entry is a directory in a main checkout and a file in a worktree.
 *
 * @returns `null` when no ancestor holds one.
 */
export async function enclosingWorkingTree(directory: PathBuilderLike): Promise<string | null> {
	let current = await tryRealPath(directory)

	while (current) {
		if (await tryStatLink(resolvePath(current, ".git"))) return current

		const parent = dirname(current)

		if (parent === current) return null

		current = parent
	}

	return null
}

/**
 * Compare the checkout that holds `entryDirectory` with the checkout `@mailwoman/core` was loaded from.
 *
 * @param entryDirectory The entry point's own directory, `import.meta.dirname`.
 * The working directory would misreport a deliberate run of another checkout's
 * binary from inside a worktree.
 * @returns `null` when either side sits in no working tree.
 * An installed copy of the package returns `null`, because its computed root is a `node_modules` directory.
 */
export async function readCheckoutLocality(entryDirectory: PathBuilderLike): Promise<CheckoutLocality | null> {
	const entryTree = await enclosingWorkingTree(entryDirectory)

	if (!entryTree) return null

	const loadedTree = await tryRealPath(repoRootPath())

	if (!loadedTree || !(await tryStatLink(resolvePath(loadedTree, ".git")))) return null

	const nodeModulesPath = resolvePath(entryTree, "node_modules")
	const nodeModulesStats = await tryStatLink(nodeModulesPath)

	const nodeModules = !nodeModulesStats
		? { state: NodeModulesState.Absent, target: null }
		: nodeModulesStats.isSymbolicLink()
			? { state: NodeModulesState.Link, target: await tryRealPath(nodeModulesPath) }
			: { state: NodeModulesState.Directory, target: null }

	return { entryTree, loadedTree, nodeModules, local: entryTree === loadedTree }
}

/**
 * One paragraph naming both checkouts, the cause, and the repair.
 */
export function describeCheckoutLeak(locality: CheckoutLocality): string {
	const { entryTree, loadedTree, nodeModules } = locality

	const cause =
		nodeModules.state === NodeModulesState.Absent
			? `${entryTree} has no node_modules, so Node walked up the parent directories and resolved @mailwoman/core from ${loadedTree}.`
			: nodeModules.state === NodeModulesState.Link
				? `${entryTree}/node_modules is a link to ${nodeModules.target ?? "a missing target"}, so @mailwoman/core resolved from ${loadedTree}.`
				: `${entryTree}/node_modules resolves @mailwoman/core from ${loadedTree}.`

	const repair =
		nodeModules.state === NodeModulesState.Link
			? `Remove the node_modules link and run \`yarn install\` in ${entryTree}.`
			: `Run \`yarn install\` in ${entryTree}.`

	return (
		`This entry point is in ${entryTree} but runs on the packages of ${loadedTree}. ${cause} ` +
		`Repository paths, health checks and artifact writes would act on ${loadedTree}. ${repair}`
	)
}

/**
 * Raised when an entry point would run on another checkout's packages.
 *
 * It is a `CommandError`, so `runCLICommand` prints the guidance without a stack.
 */
export class CheckoutLocalityError extends CommandError {
	public readonly locality: CheckoutLocality

	constructor(locality: CheckoutLocality) {
		super(describeCheckoutLeak(locality))
		this.name = "CheckoutLocalityError"
		this.locality = locality
	}
}

/**
 * Refuse to continue when the entry point's checkout and the loaded `@mailwoman/core`'s checkout differ.
 *
 * @throws CheckoutLocalityError naming both checkouts and the repair.
 */
export async function assertCheckoutLocality(entryDirectory: PathBuilderLike): Promise<void> {
	const locality = await readCheckoutLocality(entryDirectory)

	if (locality && !locality.local) throw new CheckoutLocalityError(locality)
}
