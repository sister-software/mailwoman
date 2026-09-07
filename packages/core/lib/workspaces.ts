/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The root manifest's `workspaces` field, expanded to the directories it names. Yarn accepts globs in that field and
 *   the repository writes `packages/*` beside the literal `docs`; every reader that walks the workspaces goes through
 *   here so a glob is expanded once, the same way, and a literal entry that names no manifest is an error rather than
 *   an empty result. Only a single trailing `*` segment is supported: the repository never writes another shape, and
 *   a pattern this reader cannot expand must refuse, because "matched nothing" would read as "no workspaces".
 */

import { type PathBuilderLike, resolvePath } from "path-ts"

import { readDirectoryEntries, readLocalJSONFile, tryStat } from "#fs/readers"

interface RootManifest {
	workspaces?: string[]
}

const TRAILING_STAR = /^(?<parent>[^*]+)\/\*$/u

async function isWorkspaceDirectory(repoRoot: PathBuilderLike, directory: string): Promise<boolean> {
	return (await tryStat(resolvePath(repoRoot, directory, "package.json"))) !== null
}

export interface ReadWorkspaceDirectoriesOptions {
	/**
	 * Skip a literal entry whose directory carries no manifest instead of failing. A checkout at an older ref may predate
	 * a workspace the field names; a reader that resolves that ref's own tree wants absence, not an error.
	 *
	 * @default false
	 */
	tolerateMissing?: boolean
}

/**
 * Repo-relative workspace directories, in the field's order: a literal entry stays where it is, and a `parent/*` entry
 * expands to every child of `parent` that carries a `package.json`, sorted by name.
 */
export async function readWorkspaceDirectories(
	repoRoot: PathBuilderLike,
	options: ReadWorkspaceDirectoriesOptions = {}
): Promise<string[]> {
	const manifest = await readLocalJSONFile<RootManifest>(resolvePath(repoRoot, "package.json"))
	const entries = manifest.workspaces ?? []

	if (!entries.length) throw new Error(`${resolvePath(repoRoot, "package.json")} declares no workspaces`)

	const directories: string[] = []

	for (const entry of entries) {
		if (!entry.includes("*")) {
			if (!(await isWorkspaceDirectory(repoRoot, entry))) {
				if (options.tolerateMissing) continue

				throw new Error(`workspace ${entry} has no package.json under ${String(repoRoot)}`)
			}

			directories.push(entry)

			continue
		}

		const parent = TRAILING_STAR.exec(entry)?.groups?.["parent"]

		if (!parent) throw new Error(`workspace pattern ${JSON.stringify(entry)} is not a single trailing "*" segment`)

		// Only a directory can be a workspace; a file beside them (a README) is skipped before anything is stat-ed under it.
		const children = (await readDirectoryEntries(resolvePath(repoRoot, parent)))
			.filter((dirent) => dirent.isDirectory())
			.map((dirent) => dirent.name)
			.toSorted()

		const matched: string[] = []

		for (const child of children) {
			const directory = `${parent}/${child}`

			if (await isWorkspaceDirectory(repoRoot, directory)) {
				matched.push(directory)
			}
		}

		if (!matched.length)
			throw new Error(`workspace pattern ${JSON.stringify(entry)} matched no directory with a package.json`)

		directories.push(...matched)
	}

	return [...new Set(directories)]
}

/**
 * True when `directory` is one of the workspaces the field names, expanded.
 */
export async function isRegisteredWorkspace(repoRoot: PathBuilderLike, directory: string): Promise<boolean> {
	return (await readWorkspaceDirectories(repoRoot)).includes(directory)
}
