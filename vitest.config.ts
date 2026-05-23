/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Root vitest config — runs tests across every workspace from the repo root.
 *
 *   Workspace package.json `exports` fields point at compiled `./out/.../index.js` paths that don't
 *   exist before `tsc` has run (and the shared tsconfig is `emitDeclarationOnly`, so `tsc` never
 *   emits `.js`). The aliases below redirect each `@mailwoman/*` import to the matching source
 *   `.ts`, so vitest can run from a clean checkout. Order matters — more specific entries first.
 */

/// <reference types="vitest/config" />

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const here = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
	resolve: {
		alias: [
			// @mailwoman/core — `solvers/*` / `filters/*` / `kysley/*` are glob subpaths that preserve
			// the trailing filename, everything else resolves to a directory `index.ts`.
			{ find: /^@mailwoman\/core\/solvers\/(.+)$/, replacement: resolve(here, "core/solvers/$1") },
			{ find: /^@mailwoman\/core\/filters\/(.+)$/, replacement: resolve(here, "core/filters/$1") },
			{ find: /^@mailwoman\/core\/kysley\/(.+)$/, replacement: resolve(here, "core/kysley/$1.ts") },
			{
				find: "@mailwoman/core/parser/proposal-pipeline",
				replacement: resolve(here, "core/parser/proposal-pipeline.ts"),
			},
			{ find: /^@mailwoman\/core\/(.+)$/, replacement: resolve(here, "core/$1/index.ts") },
			{ find: /^@mailwoman\/core$/, replacement: resolve(here, "core/index.ts") },
			// Sibling workspaces.
			{ find: /^@mailwoman\/classifiers\/(.+)$/, replacement: resolve(here, "classifiers/$1") },
			{ find: /^@mailwoman\/classifiers$/, replacement: resolve(here, "classifiers/index.ts") },
			{ find: /^@mailwoman\/corpus\/(.+)$/, replacement: resolve(here, "corpus/src/$1.ts") },
			{ find: /^@mailwoman\/corpus$/, replacement: resolve(here, "corpus/src/index.ts") },
			{ find: "@mailwoman/neural/tokenizer", replacement: resolve(here, "neural/tokenizer.ts") },
			{ find: /^@mailwoman\/neural$/, replacement: resolve(here, "neural/index.ts") },
			{ find: /^@mailwoman\/query-shape$/, replacement: resolve(here, "query-shape/index.ts") },
			{ find: /^@mailwoman\/normalize$/, replacement: resolve(here, "normalize/index.ts") },
			{ find: /^@mailwoman\/kind-classifier$/, replacement: resolve(here, "kind-classifier/index.ts") },
			{ find: /^@mailwoman\/locale-gate$/, replacement: resolve(here, "locale-gate/index.ts") },
			// `mailwoman` is the user-facing publishable workspace at /mailwoman.
			{ find: "mailwoman/server", replacement: resolve(here, "mailwoman/server/index.ts") },
			{ find: "mailwoman/sdk/test", replacement: resolve(here, "mailwoman/sdk/test/index.ts") },
			{ find: "mailwoman/sdk/repo", replacement: resolve(here, "mailwoman/sdk/repo.ts") },
			{ find: "mailwoman/sdk/cli", replacement: resolve(here, "mailwoman/sdk/cli.ts") },
			{ find: /^mailwoman$/, replacement: resolve(here, "mailwoman/index.ts") },
		],
	},
	test: {
		// isolate: true — required because @mailwoman/core/resources/libpostal has a top-level await
		// that Vite's loader treats as a cycle under shared module graphs, breaking downstream
		// `class extends ...` evaluations.
		isolate: true,
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/out/**",
			"**/examples/**",
			"**/cypress/**",
			"**/.{idea,git,cache,output,temp}/**",
			"**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
			// Playwright e2e specs live under docs/test/browser/. They use @playwright/test as the
			// runner, not vitest, but vitest's default `*.spec.ts` glob would happily pick them up
			// and crash on the unfamiliar `test.describe` API.
			"**/docs/test/browser/**",
			"**/docs/test/e2e/**",
		],
	},
})
