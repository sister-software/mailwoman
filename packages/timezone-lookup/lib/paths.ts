// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Where the timezone database lives under the data root's `db/` group.
 */

import { databaseRootPath, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder } from "path-ts"

/**
 * `$MAILWOMAN_DATA_ROOT/db/timezone`, read when a path is requested.
 */
export const timezoneDatabasePath: PathBuilder = databaseRootPath(dataRootPath())("timezone")
