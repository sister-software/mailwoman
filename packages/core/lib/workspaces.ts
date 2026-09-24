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
import { Globerator } from "spliterator/node/fs"

import { tryStat } from "#fs/readers"
import { stringifyJSON } from "#json"
import { readPackageJSON } from "#module/resolve-from"

const TRAILING_STAR = /^(?<parent>[^*]+)\/\*$/u

async function isWorkspaceDirectory(repoRoot: PathBuilderLike, directory: string): Promise<boolean> {
	return (await tryStat(resolvePath(repoRoot, directory, "package.json"))) !== null
}

export interface ReadWorkspaceDirectoriesOptions {
	/**
	 * Skip a literal entry whose directory carries no manifest instead of failing.
	 *
	 * A checkout at an older ref may predate a workspace the field names.
	 * A reader that resolves that ref's own tree wants absence rather than an error.
	 *
	 * @default false
	 */
	tolerateMissing?: boolean
}

/**
 * Repo-relative workspace directories, in the field's order: a literal entry stays where it is, and a
 * `parent/*` entry expands to every child of `parent` that carries a `package.json`, sorted by name.
 */
export async function readWorkspaceDirectories(
	repoRoot: PathBuilderLike,
	options: ReadWorkspaceDirectoriesOptions = {}
): Promise<string[]> {
	const manifest = await readPackageJSON(resolvePath(repoRoot, "package.json"))
	// The field is either the pattern array or yarn's object form, which nests the same patterns under `packages`.
	const entries = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? [])

	if (!entries.length) throw new Error(`${resolvePath(repoRoot, "package.json")} declares no workspaces`)

	const directories: string[] = []

	for (const entry of entries) {
		if (!entry.includes("*")) {
			if (!(await isWorkspaceDirectory(repoRoot, entry))) {
				if (options.tolerateMissing) continue

				throw new Error(`workspace ${entry} has no package.json under ${repoRoot}`)
			}

			directories.push(entry)

			continue
		}

		const parent = TRAILING_STAR.exec(entry)?.groups?.["parent"]

		if (!parent) throw new Error(`workspace pattern ${stringifyJSON(entry)} is not a single trailing "*" segment`)

		// Only a directory can be a workspace.
		// A file beside them (a readme) is skipped before anything is stat-ed under it.
		const children = (
			await Globerator.from("*", {
				cwd: resolvePath(repoRoot, parent),
				withFileTypes: true,
				onlyFiles: false,
			}).toArray()
		)
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
			throw new Error(`workspace pattern ${stringifyJSON(entry)} matched no directory with a package.json`)

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

/**
 * Directories under a `parent/*` pattern that carry no `package.json`, in name order.
 *
 * {@link readWorkspaceDirectories} drops these, and dropping them is right:
 * a directory with no manifest is no workspace.
 * What it leaves is a directory nothing reaches.
 *
 * Retiring a workspace removes its manifest and its source, and `tsc` has already written `out/`
 * and a `tsconfig.tsbuildinfo` beside them, so the emit outlives the workspace that produced it.
 *
 * Three directories reached that state: `packages/formatter` through 5cc5f6ab9, the workspace
 * 8a40475c4 renamed to `@mailwoman/locale-hint`, and `packages/neural-web` through 349a5003c.
 * `sherif` reports each one as `packages-without-package-json`, because the
 * pattern still matches the directory.
 *
 * A literal workspace entry is not examined.
 * `readWorkspaceDirectories` refuses one whose manifest is absent rather than skipping it,
 * so a literal entry never produces this shape.
 */
// repo-health-ignore export-name-affix -- answers the complement of the shared reader's filter.
// It names what the glob matched and the manifest test refused.
export async function retiredWorkspaceDirectories(repoRoot: PathBuilderLike): Promise<string[]> {
	const manifest = await readPackageJSON(resolvePath(repoRoot, "package.json"))
	const entries = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? [])
	const retired: string[] = []

	for (const entry of entries) {
		const parent = TRAILING_STAR.exec(entry)?.groups?.["parent"]

		if (!parent) continue

		const children = (
			await Globerator.from("*", {
				cwd: resolvePath(repoRoot, parent),
				withFileTypes: true,
				onlyFiles: false,
			}).toArray()
		)
			.filter((dirent) => dirent.isDirectory())
			.map((dirent) => dirent.name)
			.toSorted()

		for (const child of children) {
			const directory = `${parent}/${child}`

			if (!(await isWorkspaceDirectory(repoRoot, directory))) {
				retired.push(directory)
			}
		}
	}

	return [...new Set(retired)]
}
