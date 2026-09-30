/**
 * Fast, hermetic tests.
 *
 * A test sits beside the module it covers, and a plain `<name>.test.ts` runs here.
 * The `.integration.test.ts` and `.full.test.ts` suffixes select the slow and full suites instead.
 */
import { defineConfig, mergeConfig } from "vitest/config"

import baseConfig from "./vitest.config.ts"

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["*.{test,spec}.{ts,tsx}", "{packages/*,docs}/**/*.test.{ts,tsx}"],
			exclude: ["**/*.integration.test.{ts,tsx}", "**/*.full.test.{ts,tsx}"],
		},
	})
)
