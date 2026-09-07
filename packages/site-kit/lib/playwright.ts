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
		timeout: 60_000,
		retries: CI ? 1 : 0,
		use: { baseURL, ...devices["Desktop Chrome"] },
		projects: [{ name: "chromium" }],
		webServer: remoteURL
			? undefined
			: { command: "yarn build && yarn preview", url: baseURL, timeout: 300_000, reuseExistingServer: !CI },
	})
}
