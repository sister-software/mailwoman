/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import * as fs from "node:fs/promises"
import { PathBuilder, PathBuilderLike } from "path-ts"
import { $ } from "zx"
import { tryStat } from "./fs.js"

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

	await fs.mkdir(ownerDirectory, { recursive: true })

	const exists = await tryStat(repoDirectory)

	return { ownerDirectory, repoDirectory, exists }
}

/**
 * Synchronize a repository source, i.e. clone or pull the repository.
 */
export async function synchronizeRepo(source: RepositorySource, localRepoDirectory: PathBuilderLike): Promise<void> {
	if (source.name.includes("deprecated")) return

	const { ownerDirectory, repoDirectory, exists } = await prepareRepositoryDirectories(source, localRepoDirectory)

	if (exists) {
		const shell = $({
			cwd: repoDirectory.toString(),
		})

		await shell`git pull`

		return
	}

	const shell = $({
		cwd: ownerDirectory.toString(),
	})

	await shell`git clone --depth=1 ${source.url}`
}
