/**
 * @file Playwright configuration for the docs site's build-health check. The browser suite for the geocoder lives with
 *   the app in `packages/earth`; what remains here asserts that `docusaurus build` succeeds with no warnings or
 *   errors.
 * @see https://playwright.dev/docs/test-configuration
 */

import { defineConfig } from "@playwright/test"

// Playwright loads this file with its own loader. The loader walks up from every import to find a tsconfig.
// An import of `$public` from @mailwoman/core adds core/tsconfig.json to that walk. Playwright
// handles neither of the things it relies on — a package-name `extends` resolved from hoisted
// node_modules, nor directory-style `references` ("../codex", which TypeScript reads as
// "../codex/tsconfig.json"). Node and tsc accept both forms. This loader chokes
// before it ever reads the `tsconfig` option below.
//
// So this file reads the one variable it needs directly, the same carve-out the run-docs skill driver
// takes for the same reason: an external runner loads it before the repo's helpers are reachable.
// oxlint-disable-next-line sister-software/no-process-globals -- see above. Playwright loads this outside the module graph
const env = process.env

const CI = !!env.CI

// oxlint-disable-next-line sister-software/no-process-globals -- the same carve-out: the selected projects are Playwright's argv
const argv = process.argv

const projectFlags = argv.flatMap((arg, index) =>
	arg === "--project" ? [argv[index + 1]] : arg.startsWith("--project=") ? [arg.slice("--project=".length)] : []
)

const SEARCH_ONLY = projectFlags.length > 0 && projectFlags.every((name) => name === "search")

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
	projects: [
		{ name: "build" },
		// The search suite drives the production build in `docs/build`, served on 7770 by the web server below.
		{
			name: "search",
			testDir: "./test/e2e",
			timeout: 30_000,
			use: { baseURL: "http://localhost:7770" },
		},
	],
	// Playwright's web server is configuration-wide, and the `build` project writes `docs/build`
	// rather than reading it, so the server starts only when the run selects just the `search` project.
	// A running `yarn workspace @mailwoman/docs serve` is reused.
	webServer: SEARCH_ONLY
		? {
				command: "yarn docusaurus serve --port 7770 --no-open",
				url: "http://localhost:7770",
				reuseExistingServer: true,
				timeout: 60_000,
			}
		: undefined,
})
