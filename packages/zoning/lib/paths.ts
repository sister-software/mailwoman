/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the zoning layer database and its download cache live under the data root's `db/` group.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/zoning`.
 */
export function zoningDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("zoning")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/zoning`, read when a path is requested.
 *
 * @see {@link zoningDatabaseRoot} for another data root.
 */
export const zoningDatabasePath: PathBuilder = zoningDatabaseRoot(dataRootPath())
