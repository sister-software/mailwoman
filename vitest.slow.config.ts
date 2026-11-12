// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Integration tests cover process, filesystem, database and model boundaries.
 * They also exercise large-data paths.
 */
import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config.ts"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["{packages,lib}/*/**/*.integration.test.{ts,tsx}"],
		},
	})
)
