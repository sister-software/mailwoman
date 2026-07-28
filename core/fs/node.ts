/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Stats } from "node:fs"
import { stat } from "node:fs/promises"

import type { PathBuilderLike } from "path-ts"

export { existsSync } from "node:fs"

/**
 * Attempts to stat a file or directory.
 *
 * @throws If the path exists but cannot be statted for some reason other than non-existence.
 */
export function tryStat(pathBuilderLike: PathBuilderLike): Promise<Stats | null> {
	return stat(pathBuilderLike.toString()).catch((error) => {
		if (error.code === "ENOENT") return null

		throw error
	})
}

/**
 * Whether a path exists and is a directory.
 */
export async function isDirectory(path: PathBuilderLike): Promise<boolean> {
	return tryStat(path)
		.then((stats) => stats?.isDirectory() ?? false)
		.catch((error) => {
			if (error.code === "ENOENT") return false
			throw error
		})
}
