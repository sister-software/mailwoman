// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import envPaths, { type Paths } from "env-paths"
import { resolvePath } from "path-ts"

const platformPaths = envPaths("mailwoman", { suffix: "" })

/**
 * Platform-native filesystem defaults used by the typed environment schema. No log root: Mailwoman writes no persistent
 * log of its own, so the platform log directory is not a setting.
 */
export const DefaultMailwomanPaths: Omit<Paths, "log"> = {
	data: resolvePath(platformPaths.data),
	config: resolvePath(platformPaths.config),
	cache: resolvePath(platformPaths.cache),
	temp: resolvePath(platformPaths.temp),
}
