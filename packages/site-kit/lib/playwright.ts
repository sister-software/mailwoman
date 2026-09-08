/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Playwright configuration a static site's smoke runs under: `vite preview` over a fresh build, which serves
 *   `dist/` with the same SPA fallback Cloudflare applies, or a deployment when the named variable carries its URL.
 */

import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test"

export interface PreviewConfigOptions {
	port: number
	/**
	 * The environment variable that, when set, points the specs at a deployment instead of the preview server.
	 */
	remoteURLVariable: string
}

export function previewConfig(options: PreviewConfigOptions): PlaywrightTestConfig {
	// oxlint-disable-next-line sister-software/no-process-globals -- Playwright loads this outside the module graph, as docs/playwright.config.ts explains
	const env = process.env
	const remoteURL = env[options.remoteURLVariable]
	const baseURL = remoteURL ?? `http://localhost:${options.port}`
	const CI = Boolean(env["CI"])

	return defineConfig({
		testDir: "./test/browser",
		// A cold load fetches a 25 MB model and range-reads a gazetteer before the first query can run, so the per-test
		// budget, the navigation budget and the per-action budget all leave room for that; one worker keeps the loads
		// from competing for the same bandwidth.
		timeout: 120_000,
		workers: 1,
		fullyParallel: false,
		forbidOnly: CI,
		retries: CI ? 1 : 0,
		maxFailures: CI ? 5 : 2,
		reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
		use: {
			baseURL,
			...devices["Desktop Chrome"],
			actionTimeout: 30_000,
			navigationTimeout: 180_000,
			trace: "on-first-retry",
			screenshot: "only-on-failure",
		},
		projects: [{ name: "chromium" }],
		webServer: remoteURL
			? undefined
			: { command: "yarn build && yarn preview", url: baseURL, timeout: 300_000, reuseExistingServer: !CI },
	})
}
