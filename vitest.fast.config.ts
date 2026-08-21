/**
 * Fast, hermetic tests. A file belongs here by living under a workspace's `test/unit/` directory.
 */
import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config.ts"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: [
				"*.{test,spec}.{ts,tsx}",
				"{packages/*,docs}/test/unit/**/*.{test,spec}.{ts,tsx}",
				"scripts/**/*.{test,spec}.{ts,tsx}",
			],
		},
	})
)
