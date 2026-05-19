/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-package vitest config that resolves the package's own @mailwoman/core subpath imports to
 *   source. The package.json exports field points at ./out/core/.../index.js — those files don't
 *   exist until tsc has run. With this alias, vitest can run from a clean checkout.
 *
 *   The regex alias maps every @mailwoman/core/<subpath> (including nested ones like
 * @mailwoman/core/resources/languages) to the corresponding source index. The bare
 * @mailwoman/core entry handles the package's own top-level index.
 */

/// <reference types="vitest/config" />

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const here = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
	resolve: {
		alias: [
			// Order matters — more specific entries first. @mailwoman/core's subpaths split between
			// core/* (classification, tokenization, types, …) and package-root (utils, policy,
			// locale, solvers, filters) — package.json exports list them at distinct prefixes.
			{ find: "@mailwoman/core/utils", replacement: resolve(here, "utils/index.ts") },
			{ find: "@mailwoman/core/locale", replacement: resolve(here, "locale/index.ts") },
			{ find: "@mailwoman/core/policy", replacement: resolve(here, "policy/index.ts") },
			{ find: /^@mailwoman\/core\/solvers\/(.+)$/, replacement: resolve(here, "solvers/$1") },
			{ find: "@mailwoman/core/solvers", replacement: resolve(here, "solvers/index.ts") },
			{ find: /^@mailwoman\/core\/filters\/(.+)$/, replacement: resolve(here, "filters/$1") },
			{ find: "@mailwoman/core/filters", replacement: resolve(here, "filters/index.ts") },
			// Fallback: every other @mailwoman/core/<name> is under core/<name>/index.ts.
			{ find: /^@mailwoman\/core\/(.+)$/, replacement: resolve(here, "core/$1/index.ts") },
			{ find: /^@mailwoman\/core$/, replacement: resolve(here, "core/index.ts") },
			// sdk/test (used by tokenization tests) imports the root `mailwoman` package, which
			// transitively re-exports @mailwoman/classifiers + @mailwoman/core. Alias all three to
			// source so the chain resolves without needing a compile step.
			{ find: /^@mailwoman\/classifiers\/(.+)$/, replacement: resolve(here, "../classifiers/classifiers/$1") },
			{ find: /^@mailwoman\/classifiers$/, replacement: resolve(here, "../classifiers/classifiers/index.ts") },
			// `mailwoman/core` and friends resolve via the root package.json's subpath exports —
			// which point at `packages/core/out/core/...`. Mirror that same shape for source mode.
			{ find: "mailwoman/core/utils", replacement: resolve(here, "utils/index.ts") },
			{ find: "mailwoman/core/locale", replacement: resolve(here, "locale/index.ts") },
			{ find: "mailwoman/core/policy", replacement: resolve(here, "policy/index.ts") },
			{ find: /^mailwoman\/core\/(.+)$/, replacement: resolve(here, "core/$1/index.ts") },
			{ find: "mailwoman/core", replacement: resolve(here, "core/index.ts") },
			{ find: /^mailwoman$/, replacement: resolve(here, "../../index.ts") },
		],
	},
	test: {
		isolate: false,
		exclude: ["**/node_modules/**", "**/out/**", "**/dist/**"],
	},
})
