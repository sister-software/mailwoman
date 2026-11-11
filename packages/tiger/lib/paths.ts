/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the TIGER databases live under the data root's `db/` group.
 *   `tiger fetch` and `tiger redistricting` build `tiger.db` from the TIGER/Line and P.L. 94-171 downloads,
 *   and the corpus `tiger` adapter, `gazetteer build bdc` and `tiger race-dots` read it.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/tiger`.
 */
export function tigerDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("tiger")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/tiger`, read when a path is requested.
 *
 * @see {@link tigerDatabaseRoot} for another data root.
 */
export const tigerDatabasePath: PathBuilder = tigerDatabaseRoot(dataRootPath())
