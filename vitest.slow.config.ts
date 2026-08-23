/**
 * Integration tests: process, filesystem, database, model, and large-data boundaries.
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
