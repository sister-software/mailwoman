/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The workspace directories the root manifest names, with every yarn pattern expanded.
 *
 *   A `workspaces` entry is EITHER a directory (`docs`) or a pattern (`packages/*`), and yarn accepts both
 *   interchangeably. Five readers took every entry for a literal path, so each one answered wrongly the moment the
 *   explicit list became a pattern — and only two of the five said so: the root `vitest.config.ts` and two health
 *   checks raised `ENOENT` on the unexpanded pattern, while `test-contract` inspected `docs` alone and passed, and
 *   `checkReleaseListIdentity` read all 60 release entries as dangling. A pattern that matches nothing raises here
 *   rather than answering an empty list, because every caller reads absence as a verdict about the repository.
 */

import { dirname, type PathBuilderLike, relative, resolvePath } from "path-ts"

import { globPaths, readLocalJSONFile } from "#fs/readers"

/**
 * Every workspace directory, relative to `repoRoot`, sorted.
 *
 * A workspace is a directory carrying a `package.json`, which is what yarn expands a pattern against; the glob runs
 * over that manifest rather than the directory, so a stray directory under `packages/` is not a workspace.
 *
 * @throws When the root manifest carries no usable `workspaces` array, or when an entry matches no manifest.
 */
export async function readWorkspaceDirectories(repoRoot: PathBuilderLike): Promise<string[]> {
	const { workspaces } = await readLocalJSONFile<{ workspaces?: unknown }>(resolvePath(repoRoot, "package.json"))

	if (!Array.isArray(workspaces) || !workspaces.length) {
		throw new Error(`${repoRoot}/package.json carries no non-empty workspaces array`)
	}

	const directories: string[] = []

	for (const entry of workspaces) {
		if (typeof entry !== "string") {
			throw new TypeError(
				`${repoRoot}/package.json workspaces array carries a non-string entry: ${JSON.stringify(entry)}`
			)
		}

		const matches = await globPaths(resolvePath(repoRoot, entry, "package.json"))

		if (!matches.length) {
			throw new Error(`workspaces entry "${entry}" matches no package.json under ${repoRoot}`)
		}

		for (const manifestPath of matches) {
			directories.push(relative(repoRoot.toString(), dirname(manifestPath)))
		}
	}

	return directories.toSorted()
}
