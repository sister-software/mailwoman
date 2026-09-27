// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
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
