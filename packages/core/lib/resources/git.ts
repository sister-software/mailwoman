/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PathBuilder, type PathBuilderLike } from "path-ts"

import { tryStat } from "#fs/readers/stat"
import { makeDirectories } from "#fs/writers"
import { GitClient } from "#git"

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

	await makeDirectories(ownerDirectory.toString())

	const exists = await tryStat(repoDirectory)

	return { ownerDirectory, repoDirectory, exists }
}

/**
 * What a synchronization did, so a caller can report it.
 *
 * A clone and a pull differ by orders of magnitude in both time and bytes —
 * reporting them as one "synchronized" makes a first-time clone indistinguishable
 * from a no-op refresh while it holds the progress display still.
 */
export type SynchronizeAction = "cloned" | "pulled" | "skipped"

/**
 * Synchronize a repository source, i.e. clone or pull the repository.
 *
 * The transfer runs through `client`, so a caller that watches the client's `progress`
 * events sees the clone or pull advance, and disposing the client stops it.
 */
export async function synchronizeRepo(
	source: RepositorySource,
	localRepoDirectory: PathBuilderLike,
	client: GitClient = new GitClient({ cwd: localRepoDirectory })
): Promise<SynchronizeAction> {
	if (source.name.includes("deprecated")) return "skipped"

	const { repoDirectory, exists } = await prepareRepositoryDirectories(source, localRepoDirectory)

	if (exists) {
		await client.start(["-C", repoDirectory.toString(), "pull", "--progress"]).result

		return "pulled"
	}

	await client.clone(source.url, repoDirectory, { depth: 1 })

	return "cloned"
}
