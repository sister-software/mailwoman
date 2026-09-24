/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the coastal-erosion layer database and its download cache live under the data root's `db/` group.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/coastal`.
 */
export function coastalDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("coastal")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/coastal`, read when a path is requested.
 *
 * @see {@link coastalDatabaseRoot} for another data root.
 */
export const coastalDatabasePath: PathBuilder = coastalDatabaseRoot(dataRootPath())
