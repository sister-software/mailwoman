/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the BAN databases live under the data root's `db/` group:
 *   the address-point and street-centroid databases and their attribution records.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/ban`.
 */
export function banDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("ban")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/ban`, read when a path is requested.
 *
 * @see {@link banDatabaseRoot} for another data root.
 */
export const banDatabasePath: PathBuilder = banDatabaseRoot(dataRootPath())
