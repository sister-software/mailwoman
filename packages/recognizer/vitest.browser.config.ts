// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Vitest browser-mode config for `@mailwoman/recognizer`.
 *
 *   Runs `lib/**\/*.browser.test.ts` in a real headless Chromium through the Playwright
 *   provider, the way `@mailwoman/react` and the map apps run their browser tests.
 *   The test proves the first recognition instantiates the engine synchronously on the page's main thread.
 *
 *   The package resolves through its `exports` map, so `yarn compile` comes first.
 *   The root Vitest sweep excludes these files, and CI runs this config as its own step.
 */

import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["lib/**/*.browser.test.ts"],
		browser: {
			enabled: true,
			provider: playwright(),
			headless: true,
			instances: [{ browser: "chromium" }],
		},
	},
})
