/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Vitest browser-mode config for `@mailwoman/react`. Runs the component + hook tests in a real
 *   headless Chromium via the Playwright provider — DOM APIs (clipboard, timers, layout) are genuine,
 *   which is the point: these components run in the browser, so they're tested there. Kept OUT of the
 *   repo-root `vitest.config.ts` sweep (that run excludes `react/**` test files), so this is the only
 *   entry that executes them.
 */

import react from "@vitejs/plugin-react"
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

export default defineConfig({
	plugins: [react()],
	test: {
		include: ["**/*.test.ts", "**/*.test.tsx"],
		setupFiles: ["./test/setup.ts"],
		browser: {
			enabled: true,
			provider: playwright(),
			headless: true,
			instances: [{ browser: "chromium" }],
		},
	},
})
