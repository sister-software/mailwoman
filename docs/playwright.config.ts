/**
 * @file Playwright configuration for the docs site's build-health check. The browser suite for the geocoder lives with
 *   the app in `packages/earth`; what remains here asserts that `docusaurus build` succeeds with no warnings or
 *   errors.
 * @see https://playwright.dev/docs/test-configuration
 */

import { defineConfig } from "@playwright/test"

// Playwright loads this file with its OWN loader, which walks up from every import to find a tsconfig.
// Importing `$public` from @mailwoman/core drags core/tsconfig.json into that walk, and Playwright
// handles neither of the things it relies on — a package-name `extends` resolved from hoisted
// node_modules, nor directory-style `references` ("../codex", which TypeScript reads as
// "../codex/tsconfig.json"). Both are fine under Node and tsc; only this loader chokes, and it does so
// before it ever reads the `tsconfig` option below.
//
// So this file reads the one variable it needs directly, the same carve-out the run-docs skill driver
// takes for the same reason: an external runner loads it before the repo's helpers are reachable.
// oxlint-disable-next-line sister-software/no-process-globals -- see above; Playwright loads this outside the module graph
const env = process.env

const CI = !!env.CI

export default defineConfig({
	testDir: "./test/build",
	forbidOnly: CI,
	retries: 0,
	workers: 1,
	// The production build can take a few minutes from a cold cache.
	timeout: 600_000,
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
	projects: [{ name: "build" }],
})
