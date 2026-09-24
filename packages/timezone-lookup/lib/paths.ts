/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the timezone database lives under the data root's `db/` group.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder } from "path-ts"

/**
 * `$MAILWOMAN_DATA_ROOT/db/timezone`, read when a path is requested.
 */
export const timezoneDatabasePath: PathBuilder = databaseRootPath(dataRootPath())("timezone")
