/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PathLike, Stats } from "node:fs"
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"

import type { PathBuilderLike } from "path-ts"

/**
 * Attempts to stat a file or directory.
 *
 * @throws If the path exists but cannot be statted for some reason other than non-existence.
 */
export function tryStat(pathBuilderLike: PathBuilderLike): Promise<Stats | null> {
	return stat(pathBuilderLike.toString()).catch((err) => {
		if (err.code === "ENOENT") return null

		throw err
	})
}

/**
 * Whether a path exists and is a directory.
 */
export async function isDirectory(path: PathBuilderLike): Promise<boolean> {
	return tryStat(path)
		.then((stats) => stats?.isDirectory() ?? false)
		.catch((err) => {
			if (err.code === "ENOENT") return false
			throw err
		})
}

export { existsSync }
