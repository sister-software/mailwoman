// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { stat } from "node:fs/promises"
import { PathBuilderLike } from "path-ts"

/**
 * Check if a file or directory exists.
 */
export function checkIfExists(pathBuilderLike: PathBuilderLike): Promise<boolean> {
	return stat(pathBuilderLike)
		.then(() => true)
		.catch(() => false)
}
