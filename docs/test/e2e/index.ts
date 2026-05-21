/**
 * @file Playwright e2e test helpers for the mailwoman /demo page.
 *
 *   Mirrors the authentik web/e2e/ structure: re-export a `test` object extended with named fixtures,
 *   plus the standard `expect`. Spec files import as `import { expect, test } from "#e2e"` via the
 *   package.json imports map.
 */

import { test as base } from "@playwright/test"

import { ConsoleFixture } from "./fixtures/ConsoleFixture.js"
import { DemoFixture } from "./fixtures/DemoFixture.js"

export { expect } from "@playwright/test"

interface E2EFixtures {
	/** Captures console messages + page errors + failed requests for a single test. */
	console: ConsoleFixture
	/** High-level actions on the /demo page: load, set address, submit, read results. */
	demo: DemoFixture
}

/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixtures bind via destructured
   `use` callback; eslint's react-hooks plugin misreads this as a React Hook violation. */
export const test = base.extend<E2EFixtures>({
	// `console` fixture is set up FIRST so it captures messages emitted during the demo
	// fixture's own page.goto(). Playwright resolves the dependency graph by the order
	// arguments are destructured; we destructure `console` before `page` in DemoFixture.
	console: async ({ page }, use) => {
		const fixture = new ConsoleFixture(page)
		await use(fixture)
	},

	demo: async ({ page, console: consoleFixture }, use) => {
		const fixture = new DemoFixture(page, consoleFixture)
		await use(fixture)
	},
})
/* eslint-enable react-hooks/rules-of-hooks */
