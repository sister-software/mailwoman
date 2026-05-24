/**
 * @file Playwright configuration for the mailwoman /demo end-to-end suite.
 * @see https://playwright.dev/docs/test-configuration
 *
 *   Shape ported from sister-software/authentik's web/playwright.config.js — single chromium
 *   project, fixtures live under test/e2e/, specs under test/browser/. Default baseURL points
 *   at the production deploy; override with MAILWOMAN_DEMO_URL for staging or a local
 *   `yarn serve` instance.
 */

import { defineConfig, devices } from "@playwright/test"

const CI = !!process.env["CI"]

const baseURL = process.env["MAILWOMAN_DEMO_URL"] ?? "https://mailwoman.sister.software"

export default defineConfig({
	testDir: "./test/browser",
	fullyParallel: false,
	forbidOnly: CI,
	retries: CI ? 1 : 0,
	workers: 1,
	maxFailures: CI ? 5 : 2,
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
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
			},
		},
	],
})
