// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Vitest config that runs `lib/**\/*.workers.test.ts` under the Workers runtime through Miniflare,
 *   the way `@mailwoman/gazetteer-worker` and `@mailwoman/license-worker` run their tests.
 *
 *   The test proves the `workerd` entry instantiates the imported `.wasm` module synchronously
 *   on the first call, in a runtime that refuses to compile WebAssembly from bytes.
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
