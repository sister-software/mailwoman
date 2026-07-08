/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-package vitest config that resolves @mailwoman/core subpath imports to source. The
 *   package.json `exports` field points at `./out/.../index.js` — those files don't exist until tsc
 *   has run. With these aliases vitest can run from a clean checkout.
 *
 *   `solvers/*` and `filters/*` use a glob-style export, so the alias mirrors that with a regex that
 *   preserves the trailing path segment.
 */

import { resolve } from "node:path"

// `defineConfig` from "vitest/config" (not "vite"): vitest's overload carries the `test` field.
// vite 8 (pulled in by docs/ Storybook) no longer applies the `vitest/config` type augmentation to
// vite's own `defineConfig`, so importing from "vite" makes `test` a type error under vite 8.
import { defineConfig } from "vitest/config"

const here = import.meta.dirname

export default defineConfig({
	resolve: {
		alias: [
			// Order matters — more specific entries first.
			{ find: /^@mailwoman\/core\/solvers\/(.+)$/, replacement: resolve(here, "solvers/$1") },
			{ find: /^@mailwoman\/core\/filters\/(.+)$/, replacement: resolve(here, "filters/$1") },
			// Every @mailwoman/core/<subpath> resolves to the index.ts of the matching subdir.
			{ find: /^@mailwoman\/core\/(.+)$/, replacement: resolve(here, "$1/index.ts") },
			{ find: /^@mailwoman\/core$/, replacement: resolve(here, "index.ts") },
			// Sibling workspaces.
			{ find: /^@mailwoman\/classifiers$/, replacement: resolve(here, "../classifiers/index.ts") },
			{ find: /^@mailwoman\/corpus\/(.+)$/, replacement: resolve(here, "../corpus/src/$1.ts") },
			{ find: /^@mailwoman\/corpus$/, replacement: resolve(here, "../corpus/src/index.ts") },
			// The root `mailwoman` package — sdk/test imports it (transitively re-exports core +
			// classifiers). Tests across workspaces also import `mailwoman/sdk/test` directly.
			{ find: "mailwoman/sdk/test", replacement: resolve(here, "../mailwoman/sdk/test/index.ts") },
			{ find: /^mailwoman$/, replacement: resolve(here, "../mailwoman/index.ts") },
		],
	},
	test: {
		// isolate: true (default) — required because @mailwoman/core/resources/libpostal has a
		// top-level await that Vite's loader treats as a cycle under shared module graphs,
		// breaking downstream `class extends ...` evaluations.
		isolate: true,
		exclude: ["**/node_modules/**", "**/out/**", "**/dist/**"],
	},
})
