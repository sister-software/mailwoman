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
			include: ["packages/*/test/integration/**/*.{test,spec}.{ts,tsx}"],
		},
	})
)
