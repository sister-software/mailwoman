/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Root vitest config — runs tests across every workspace from the repo root.
 *
 *   Historical premise: workspace `exports` pointed only at compiled `./out/.../index.js` paths, so
 *   these aliases redirected each `@mailwoman/*` import to source `.ts` for clean-checkout runs.
 *   Since the first-class-TS migration, every exports entry carries a `node` condition pointing at
 *   the source `.ts`, so most of this list is redundant with plain exports resolution and is a
 *   removal candidate. It stays for now because Vite's applied condition set differs from Node's.
 *   Order matters — more specific entries first.
 */

/// <reference types="vitest/config" />

import { resolve } from "node:path"

import { defineConfig } from "vite"

const here = import.meta.dirname

export default defineConfig({
	resolve: {
		alias: [
			// @mailwoman/core — `kysley/*` is a glob subpath that preserves the trailing filename,
			// everything else resolves to a directory `index.ts`.
			{ find: /^@mailwoman\/core\/kysley\/(.+)$/, replacement: resolve(here, "core/kysley/$1.ts") },
			// coarse-placer (#244) is a single-file subpath (no index.ts), so the generic core/$1/index.ts
			// rule below would mis-resolve it. Map it to the file directly.
			{ find: "@mailwoman/core/coarse-placer", replacement: resolve(here, "core/coarse-placer/coarse-placer.ts") },
			// `objects` is a bare file (core/objects.ts), so it must beat the generic dir rule below — a
			// transitive import (e.g. @mailwoman/spatial → @mailwoman/core/objects) hits this from any test.
			{ find: /^@mailwoman\/core\/objects$/, replacement: resolve(here, "core/objects.ts") },
			// `fs` is the node build (core/fs/node.ts), not a directory index — must beat the generic rule.
			{ find: /^@mailwoman\/core\/fs$/, replacement: resolve(here, "core/fs/node.ts") },
			{ find: /^@mailwoman\/core\/(.+)$/, replacement: resolve(here, "core/$1/index.ts") },
			{ find: /^@mailwoman\/core$/, replacement: resolve(here, "core/index.ts") },
			// Sibling workspaces.
			{ find: /^@mailwoman\/address-id$/, replacement: resolve(here, "address-id/index.ts") },
			{ find: /^@mailwoman\/api-kit$/, replacement: resolve(here, "api-kit/index.ts") },
			{ find: /^@mailwoman\/api$/, replacement: resolve(here, "api/index.ts") },
			{ find: /^@mailwoman\/corpus\/(.+)$/, replacement: resolve(here, "corpus/src/$1.ts") },
			{ find: /^@mailwoman\/corpus$/, replacement: resolve(here, "corpus/src/index.ts") },
			{ find: /^@mailwoman\/formatter\/(.+)$/, replacement: resolve(here, "formatter/$1.ts") },
			{ find: /^@mailwoman\/formatter$/, replacement: resolve(here, "formatter/index.ts") },
			{ find: /^@mailwoman\/record\/(.+)$/, replacement: resolve(here, "record/$1.ts") },
			{ find: /^@mailwoman\/record$/, replacement: resolve(here, "record/index.ts") },
			{ find: /^@mailwoman\/match\/(.+)$/, replacement: resolve(here, "match/$1.ts") },
			{ find: /^@mailwoman\/match$/, replacement: resolve(here, "match/index.ts") },
			{ find: /^@mailwoman\/spatial\/sdk$/, replacement: resolve(here, "spatial/sdk/index.ts") },
			{ find: /^@mailwoman\/spatial$/, replacement: resolve(here, "spatial/index.ts") },
			{ find: /^@mailwoman\/registry\/(.+)$/, replacement: resolve(here, "registry/$1.ts") },
			{ find: /^@mailwoman\/registry$/, replacement: resolve(here, "registry/index.ts") },
			{ find: "@mailwoman/neural/tokenizer", replacement: resolve(here, "neural/tokenizer.ts") },
			{ find: /^@mailwoman\/neural$/, replacement: resolve(here, "neural/index.ts") },
			{ find: /^@mailwoman\/query-shape$/, replacement: resolve(here, "query-shape/index.ts") },
			{ find: /^@mailwoman\/normalize$/, replacement: resolve(here, "normalize/index.ts") },
			{ find: /^@mailwoman\/kind-classifier$/, replacement: resolve(here, "kind-classifier/index.ts") },
			{ find: /^@mailwoman\/locale-gate$/, replacement: resolve(here, "locale-gate/index.ts") },
			{ find: /^@mailwoman\/variant-aliases$/, replacement: resolve(here, "variant-aliases/index.ts") },
			{ find: /^@mailwoman\/phrase-grouper$/, replacement: resolve(here, "phrase-grouper/index.ts") },
			// `mailwoman` is the user-facing publishable workspace at /mailwoman.
			{ find: "mailwoman/test-kit", replacement: resolve(here, "mailwoman/test-kit/index.ts") },
			{ find: "mailwoman/cli-kit", replacement: resolve(here, "mailwoman/cli-kit/index.ts") },
			{ find: /^mailwoman$/, replacement: resolve(here, "mailwoman/index.ts") },
			// onnxruntime-web's `/webgpu` subpath ships browser-only bundles: under Node they fetch()
			// their Emscripten loader as a file:// URL (undici rejects the scheme) and then import() a
			// blob: URL (Node's ESM loader rejects that too). The root export carries a `node`
			// condition with a Node-ready build (fs-based wasm loading), so tests resolve to it.
			// Production imports keep `onnxruntime-web/webgpu` — this alias lives only in the vitest
			// module graph, where WebGPU is unavailable anyway.
			{
				find: /^onnxruntime-web\/webgpu$/,
				replacement: resolve(here, "node_modules/onnxruntime-web/dist/ort.node.min.mjs"),
			},
		],
	},
	test: {
		// isolate: true — required because @mailwoman/core/resources/libpostal has a top-level await
		// that Vite's loader treats as a cycle under shared module graphs, breaking downstream
		// `class extends ...` evaluations.
		isolate: true,
		testTimeout: 15_000,
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/out/**",
			"**/examples/**",
			"**/cypress/**",
			"**/.{idea,git,cache,output,temp}/**",
			"**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
			// Playwright e2e specs live under docs/test/browser/ + docs/test/build/. They use
			// @playwright/test as the runner, not vitest, but vitest's default `*.spec.ts` glob would
			// happily pick them up and crash on the unfamiliar `test.describe` API. (The build/ entry
			// — the `docusaurus build` health gate — was missing here, so it surfaced the moment CI
			// could reach the test phase again.)
			"**/docs/test/browser/**",
			"**/docs/test/build/**",
			"**/docs/test/e2e/**",
			// Agent worktrees under .claude/worktrees/ are isolated git checkouts; each contains a
			// full copy of the repo's test files. Without this exclude, vitest descends into every
			// active worktree and runs every test suite N×(worktree count) times.
			"**/.claude/worktrees/**",
		],
	},
})
