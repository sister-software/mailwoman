/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the undersea layer database and the downloaded gazetteer live under the data root.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder, PathBuilderLike } from "path-ts"

/**
 * `<dataRoot>/db/undersea`.
 */
export function underseaDatabaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return databaseRootPath(dataRoot)("undersea")
}

/**
 * `$MAILWOMAN_DATA_ROOT/db/undersea`, read when a path is requested.
 *
 * @see {@link underseaDatabaseRoot} for another data root.
 */
export const underseaDatabasePath: PathBuilder = underseaDatabaseRoot(dataRootPath())

/**
 * `$MAILWOMAN_DATA_ROOT/src/undersea`, where each download is kept in a directory
 * such as `2026-11-02/`, one per download date.
 */
export const underseaSourcePath: PathBuilder = dataRootPath("src", "undersea")
