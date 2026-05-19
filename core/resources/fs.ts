// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { Stats } from "node:fs"
import { stat } from "node:fs/promises"
import type { PathBuilderLike } from "path-ts"

/**
 * Attempts to stat a file or directory.
 */
export function tryStat(pathBuilderLike: PathBuilderLike): Promise<Stats | null> {
	return stat(pathBuilderLike).catch(() => null)
}
