// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Vitest config that runs `lib/**\/*.workers.test.ts` under the Workers runtime through
 *   Miniflare, the way `@mailwoman/recognize` runs its first-call test.
 *
 *   The test proves that the recognizer the parse pipeline reads, `computeQueryShape`,
 *   works in a runtime that refuses to compile WebAssembly from bytes.
 *
 *   The package resolves through its `exports` map, so `yarn compile` comes first.
 *   The root Vitest sweep excludes these files, and CI runs this config as its own step.
 */

import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.toml" } })],
	test: {
		include: ["lib/**/*.workers.test.ts"],
	},
})
