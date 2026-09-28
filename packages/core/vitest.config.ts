/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-package Vitest config that resolves `@mailwoman/core` subpath imports to source.
 *   The package `exports` field points at `./out/.../index.js` files produced by tsc.
 *   A clean checkout has no output files until tsc runs.
 *   These aliases let Vitest run from a clean checkout.
 *
 *   Several subpaths are single files instead of directories with an `index.ts`.
 *   `fs` uses the Node build at `fs/node.ts`. `objects` is the bare file `objects.ts`.
 *   `coarse-placer` and `kysley/*` also resolve to single files.
 *   Explicit entries come before the generic `<subpath> → <subpath>/index.ts` rule.
 *   That prevents resolution to a missing `index.ts` and mirrors the root config.
 */

import { resolvePath } from "path-ts"
// `defineConfig` from "vitest/config" (not "vite"): vitest's overload carries the `test` field.
// Vite 8 (pulled in by docs/ Storybook) no longer applies the `vitest/config` type augmentation
// to vite's own `defineConfig`, so importing from "vite" makes `test` a type error under vite 8.
import { defineConfig } from "vitest/config"

const here = import.meta.dirname

export default defineConfig({
	resolve: {
		alias: [
			// Order matters — more specific entries first.
			// Single-file subpaths (no directory index) must beat the generic `<subpath>/index.ts` rule below.
			{ find: /^@mailwoman\/core\/kysley\/(.+)$/, replacement: resolvePath(here, "kysley/$1.ts") },
			{ find: /^@mailwoman\/core\/coarse-placer$/, replacement: resolvePath(here, "coarse-placer/coarse-placer.ts") },
			{ find: /^@mailwoman\/core\/objects$/, replacement: resolvePath(here, "objects.ts") },
			{ find: /^@mailwoman\/core\/fs$/, replacement: resolvePath(here, "fs/node.ts") },
			{ find: /^@mailwoman\/core\/api\/disk-storage$/, replacement: resolvePath(here, "api/disk-storage.ts") },
			{ find: /^@mailwoman\/core\/api\/test-clocks$/, replacement: resolvePath(here, "api/test-clocks.ts") },
			// Every other @mailwoman/core/<subpath> resolves to the index.ts of the matching subdir.
			{ find: /^@mailwoman\/core\/(.+)$/, replacement: resolvePath(here, "$1/index.ts") },
			{ find: /^@mailwoman\/core$/, replacement: resolvePath(here, "index.ts") },
			// Sibling workspaces.
			{ find: /^@mailwoman\/corpus\/(.+)$/, replacement: resolvePath(here, "../corpus/src/$1.ts") },
			{ find: /^@mailwoman\/corpus$/, replacement: resolvePath(here, "../corpus/src/index.ts") },
			// The root `mailwoman` package — test-kit imports it (transitively re-exports core + classifiers).
			// Tests across workspaces also import `mailwoman/test-kit` directly.
			{ find: "mailwoman/test-kit", replacement: resolvePath(here, "../mailwoman/test-kit/index.ts") },
			{ find: /^mailwoman$/, replacement: resolvePath(here, "../mailwoman/index.ts") },
		],
	},
	test: {
		// isolate: true (default) — required because @mailwoman/core/resources/libpostal has
		// a top-level await that Vite's loader treats as a cycle under shared module graphs,
		// breaking downstream `class extends ...` evaluations.
		isolate: true,
		exclude: ["**/node_modules/**", "**/out/**", "**/dist/**"],
	},
})
