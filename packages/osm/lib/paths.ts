/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the national rooftop databases this package builds and serves live
 *   under the data root's `db/` group.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/osm`.
 */
export function osmDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("osm")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/osm`, read when a path is requested.
 *
 * @see {@link osmDatabaseRoot} for another data root.
 */
export const osmDatabasePath: PathBuilder = osmDatabaseRoot(dataRootPath())
