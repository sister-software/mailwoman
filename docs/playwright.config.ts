/**
 * @file Playwright configuration for the mailwoman /demo end-to-end suite.
 * @see https://playwright.dev/docs/test-configuration
 *
 *   Two run modes, selected by the `MAILWOMAN_DEMO_URL` env var:
 *
 *   - **local baseline (default)** — no `MAILWOMAN_DEMO_URL`. A `docusaurus serve` webServer is
 *     started against a freshly-built local site, and `baseURL` points at it. This is the mode that
 *     gives a meaningful pre-/post-refactor baseline: it exercises the code in _this_ checkout, not
 *     whatever is deployed. The `build` project additionally asserts the production build emits no
 *     warnings or errors.
 *   - **remote smoke** — set `MAILWOMAN_DEMO_URL` (e.g. the production deploy or a staging preview).
 *     The webServer + build project are skipped and the browser specs run straight against the URL.
 *
 *   Fixtures live under test/e2e/, demo browser specs under test/browser/, the build-health check
 *   under test/build/. Shape originally ported from sister-software/authentik's web/playwright.config.js.
 */

import { $public } from "@mailwoman/core/env"
import { defineConfig, devices } from "@playwright/test"

const CI = !!$public.CI

/** When set, run against a deployed URL and skip the local build+serve machinery. */
const remoteURL = $public.MAILWOMAN_DEMO_URL
const LOCAL_PORT = 7770
const baseURL = remoteURL ?? `http://localhost:${LOCAL_PORT}`

export default defineConfig({
	// testDir spans both suites; each project narrows to its own folder below.
	testDir: "./test",
	fullyParallel: false,
	forbidOnly: CI,
	retries: CI ? 1 : 0,
	workers: 1,
	maxFailures: CI ? 5 : 2,
	// The local build + the demo's cold-load are both slow; give the whole run room.
	timeout: 120_000,
	reporter: CI
		? [
				["github"],
				["html", { open: "never", outputFolder: "playwright-report" }],
				["json", { outputFile: "playwright-report/results.json" }],
			]
		: [
				["list", { printSteps: true }],
				["html", { open: "never" }],
			],

	use: {
		baseURL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: CI ? "retain-on-failure" : "off",
		// The demo is CPU-bound on cold-load (25 MB ONNX + 35 MB WOF + sqlite-wasm init);
		// the per-action default of 30s is too tight once we factor browser cache misses.
		actionTimeout: 30_000,
		navigationTimeout: 180_000,
	},

	projects: [
		// Build-health gate: asserts `docusaurus build` succeeds with no warnings/errors. Builds into a
		// throwaway dir (independent of the webServer-built `build/` the browser specs are served from).
		// Listed first so, with workers:1, it runs before the browser specs and a broken build fails
		// fast. Skipped in remote mode (there's no local build to check).
		...(remoteURL
			? []
			: [
					{
						name: "build",
						testDir: "./test/build",
						// The production build can take a few minutes from a cold cache.
						timeout: 600_000,
					},
				]),
		{
			name: "chromium",
			testDir: "./test/browser",
			use: { ...devices["Desktop Chrome"] },
		},
	],

	// Local mode only: build the site once, then serve the static output for the browser specs.
	// `reuseExistingServer` lets you keep a `yarn serve` running during local iteration.
	webServer: remoteURL
		? undefined
		: {
				command: "yarn build && yarn serve",
				url: baseURL,
				timeout: 600_000,
				reuseExistingServer: !CI,
				stdout: "pipe",
				stderr: "pipe",
			},
})
