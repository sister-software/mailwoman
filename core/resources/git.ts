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
 * Synchronize a repository source, i.e. clone or pull the repository.
 */
export async function synchronizeRepo(source: RepositorySource, localRepoDirectory: PathBuilderLike): Promise<void> {
	if (source.name.includes("deprecated")) return

	const { ownerDirectory, repoDirectory, exists } = await prepareRepositoryDirectories(source, localRepoDirectory)

	if (exists) {
		await execFileAsync("git", ["pull"], { cwd: repoDirectory.toString() })

		return
	}

	await execFileAsync("git", ["clone", "--depth=1", source.url], { cwd: ownerDirectory.toString() })
}
