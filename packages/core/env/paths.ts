// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import envPaths, { type Paths } from "env-paths"
import { resolvePath } from "path-ts"

const platformPaths = envPaths("mailwoman", { suffix: "" })

/**
 * Platform-native filesystem defaults used by the typed environment schema.
 */
export const DefaultMailwomanPaths: Paths = {
	data: resolvePath(platformPaths.data),
	config: resolvePath(platformPaths.config),
	cache: resolvePath(platformPaths.cache),
	log: resolvePath(platformPaths.log),
	temp: resolvePath(platformPaths.temp),
}
