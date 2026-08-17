/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import { promisify } from "node:util"

import { tryStat } from "@mailwoman/core/fs"
import { PathBuilder, type PathBuilderLike } from "path-ts"

const execFileAsync = promisify(execFile)

/**
 * Metadata for a repository source.
 */
export interface RepositorySource {
	name: string
	owner: string
	url: string
}

export async function prepareRepositoryDirectories(
	{ name, owner }: RepositorySource,
	localRepoDirectory: PathBuilderLike
) {
	const ownerDirectory = PathBuilder.from(localRepoDirectory, owner)
	const repoDirectory = ownerDirectory(name)

	await fs.mkdir(ownerDirectory.toString(), { recursive: true })

	const exists = await tryStat(repoDirectory)

	return { ownerDirectory, repoDirectory, exists }
}

/**
 * Find a cloned repository under a repository root, whichever layout it was cloned in.
 *
 * Two layouts are in use and both are legitimate. {@link synchronizeRepo} writes `<root>/<owner>/<name>`, which is what
 * the admin gazetteer's depth-agnostic GeoJSON glob reads. The postcode shards were built from repositories cloned by
 * hand as `<root>/<name>`, and a reader that knows only one layout reports a repository that is present as missing.
 *
 * Answers `null` rather than throwing so the caller owns the message — it knows which country was asked for.
 */
export async function resolveRepoDirectory(
	localRepoDirectory: PathBuilderLike,
	name: string,
	owner = "whosonfirst-data"
): Promise<string | null> {
	const root = PathBuilder.from(localRepoDirectory)

	for (const candidate of [root(owner, name), root(name)]) {
		if (await tryStat(candidate)) return candidate.toString()
	}

	return null
}

/**
 * What a synchronization did, so a caller can report it.
 *
 * A clone and a pull differ by orders of magnitude in both time and bytes — reporting them as one "synchronized" makes
 * a first-time clone indistinguishable from a no-op refresh while it holds the progress display still.
 */
export type SynchronizeAction = "cloned" | "pulled" | "skipped"

/**
 * Synchronize a repository source, i.e. clone or pull the repository.
 */
export async function synchronizeRepo(
	source: RepositorySource,
	localRepoDirectory: PathBuilderLike
): Promise<SynchronizeAction> {
	if (source.name.includes("deprecated")) return "skipped"

	const { ownerDirectory, repoDirectory, exists } = await prepareRepositoryDirectories(source, localRepoDirectory)

	if (exists) {
		await execFileAsync("git", ["pull"], { cwd: repoDirectory.toString() })

		return "pulled"
	}

	await execFileAsync("git", ["clone", "--depth=1", source.url], { cwd: ownerDirectory.toString() })

	return "cloned"
}
