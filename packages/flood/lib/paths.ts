/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the flood layer database and its download cache live under the data root's `db/` group.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/flood`.
 */
export function floodDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("flood")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/flood`, read when a path is requested.
 *
 * @see {@link floodDatabaseRoot} for another data root.
 */
export const floodDatabasePath: PathBuilder = floodDatabaseRoot(dataRootPath())
