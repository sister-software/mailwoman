/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the soil layer database and its download caches live under the data root's `db/` group.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/soil`.
 */
export function soilDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("soil")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/soil`, read when a path is requested.
 *
 * @see {@link soilDatabaseRoot} for another data root.
 */
export const soilDatabasePath: PathBuilder = soilDatabaseRoot(dataRootPath())
