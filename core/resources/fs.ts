/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Stats } from "node:fs"
import { stat } from "node:fs/promises"
import { PathBuilderLike } from "path-ts"

/**
 * Attempts to stat a file or directory.
 */
export function tryStat(pathBuilderLike: PathBuilderLike): Promise<Stats | null> {
	return stat(pathBuilderLike).catch(() => null)
}
