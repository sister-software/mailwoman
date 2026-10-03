/**
 * Full-data checks kept separate from the ordinary fast and integration sweeps.
 */
import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config.ts"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["packages/*/**/*.full.test.{ts,tsx}"],
		},
	})
)
