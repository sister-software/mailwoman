/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-package vitest config that resolves @mailwoman/core subpath imports to source. The
 *   package.json `exports` field points at `./out/.../index.js` — those files don't exist until tsc
 *   has run. With these aliases vitest can run from a clean checkout.
 *
 *   A few subpaths are single files, not directories with an `index.ts` — `fs` is the node build
 *   (`fs/node.ts`), `objects` is a bare file (`objects.ts`), `coarse-placer`/`kysley/*` are single
 *   files. Those get explicit entries BEFORE the generic `<subpath> → <subpath>/index.ts` rule,
 *   which would otherwise resolve them to a non-existent `index.ts` (mirrors the root config).
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
			// Order matters — more specific entries first. Single-file subpaths (no directory index)
			// must beat the generic `<subpath>/index.ts` rule below.
			{ find: /^@mailwoman\/core\/kysley\/(.+)$/, replacement: resolve(here, "kysley/$1.ts") },
			{ find: /^@mailwoman\/core\/coarse-placer$/, replacement: resolve(here, "coarse-placer/coarse-placer.ts") },
			{ find: /^@mailwoman\/core\/objects$/, replacement: resolve(here, "objects.ts") },
			{ find: /^@mailwoman\/core\/fs$/, replacement: resolve(here, "fs/node.ts") },
			// Every other @mailwoman/core/<subpath> resolves to the index.ts of the matching subdir.
			{ find: /^@mailwoman\/core\/(.+)$/, replacement: resolve(here, "$1/index.ts") },
			{ find: /^@mailwoman\/core$/, replacement: resolve(here, "index.ts") },
			// Sibling workspaces.
			{ find: /^@mailwoman\/classifiers$/, replacement: resolve(here, "../classifiers/index.ts") },
			{ find: /^@mailwoman\/corpus\/(.+)$/, replacement: resolve(here, "../corpus/src/$1.ts") },
			{ find: /^@mailwoman\/corpus$/, replacement: resolve(here, "../corpus/src/index.ts") },
			// The root `mailwoman` package — test-kit imports it (transitively re-exports core +
			// classifiers). Tests across workspaces also import `mailwoman/test-kit` directly.
			{ find: "mailwoman/test-kit", replacement: resolve(here, "../mailwoman/test-kit/index.ts") },
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
