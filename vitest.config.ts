/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Root vitest config — runs tests across every workspace from the repo root.
 *
 *   Workspace aliases redirect each `@mailwoman/*` import to source `.ts`, which is needed because
 *   Vite's applied condition set differs from Node's. They are GENERATED from each workspace's own
 *   `exports` map rather than hand-listed — see {@link workspaceAliases} for why the hand-listed
 *   version kept going wrong. The only hand-written entry left is the `onnxruntime-web` one below,
 *   which is not a workspace.
 */

/// <reference types="vitest/config" />

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { resolvePath } from "path-ts"
import type { Alias } from "vite"
import { defineConfig } from "vite"

const here = import.meta.dirname

const escapeRegExp = (input: string): string => input.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Derive the `@mailwoman/*` (and bare `mailwoman`) source aliases from each workspace's own `exports` map.
 *
 * Every exports entry carries a `node` condition pointing at the source `.ts` (the first-class-TS migration), which is
 * precisely what the alias list used to restate by hand. Restating it meant the two could disagree, and they did: the
 * generic `@mailwoman/core/(.+) -> core/$1/index.ts` rule assumed every subpath was a directory, so each bare-file
 * subpath needed its own earlier entry (`objects`, `fs`, `crypto`, `api/disk-storage`, …) and a NEW one was a silent
 * `Cannot find package` in unrelated suites until someone added it. The mirror-image gap on `@mailwoman/corpus/(.+) ->
 * corpus/src/$1.ts` mis-resolved the exported `./tools` DIRECTORY subpath (#1523).
 *
 * Reading the map instead means a workspace that exports a subpath is importable in tests, one that does not is not,
 * and the answer matches what a real consumer gets. Order: every exact subpath before every wildcard, longest first,
 * since Vite takes the first `find` that matches.
 */
/**
 * Read a workspace manifest.
 *
 * `parseJSONStrict` lives behind the very aliases {@link workspaceAliases} generates, so importing it here would make
 * the config depend on its own output. A malformed manifest should abort the run, which is what a bare throw does. The
 * local `escapeRegExp` above is inlined for the same reason: `@mailwoman/core/strings/regexp` sits behind the very
 * aliases this file exists to generate.
 */
async function readManifest<T>(path: string): Promise<T> {
	// oxlint-disable-next-line no-restricted-properties -- see above.
	return await readLocalJSONFile<T>(path)
}

async function workspaceAliases(): Promise<Alias[]> {
	const root = await readManifest<{ workspaces: string[] }>(resolvePath(here, "package.json"))
	const aliases: Array<Alias & { specificity: number; wildcard: boolean }> = []

	for (const workspace of root.workspaces) {
		const manifest = await readManifest<{
			name?: string
			exports?: Record<string, string | Record<string, string>>
		}>(resolvePath(here, workspace, "package.json"))

		if (!manifest.name || !manifest.exports) continue

		for (const [subpath, target] of Object.entries(manifest.exports)) {
			// The `node` condition is the source `.ts`; `default` covers a plain-string entry like `./package.json`.
			const file = typeof target === "string" ? target : (target.node ?? target.default)

			if (!file) continue

			const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1))
			const wildcard = specifier.includes("*")

			aliases.push({
				find: new RegExp(`^${specifier.split("*").map(escapeRegExp).join("(.+)")}$`),
				replacement: resolvePath(here, workspace, file).replace("*", "$1"),
				specificity: specifier.length,
				wildcard,
			})
		}
	}

	return aliases
		.toSorted((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.specificity - a.specificity)
		.map(({ find, replacement }) => ({ find, replacement }))
}

export default defineConfig({
	resolve: {
		alias: [
			...(await workspaceAliases()),
			// onnxruntime-web's `/webgpu` subpath ships browser-only bundles: under Node they fetch()
			// their Emscripten loader as a file:// URL (undici rejects the scheme) and then import() a
			// blob: URL (Node's ESM loader rejects that too). The root export carries a `node`
			// condition with a Node-ready build (fs-based wasm loading), so tests resolve to it.
			// Production imports keep `onnxruntime-web/webgpu` — this alias lives only in the vitest
			// module graph, where WebGPU is unavailable anyway.
			//
			// ASK THE PACKAGE, don't hand-assemble the dist path (2026-08-06 triage). This read
			// `resolvePath(here, "node_modules/onnxruntime-web/dist/ort.node.min.mjs")` — a literal that
			// says the same thing the comment above says, except it says it in a form the package
			// cannot correct. `import.meta.resolve("onnxruntime-web")` applies the `node` condition of
			// the exports map the comment is describing, so an ORT upgrade that renames or relocates
			// the Node bundle keeps resolving; the literal would have silently missed. Verified
			// 2026-08-06 against onnxruntime-web 1.x: it resolves to `dist/ort.node.min.mjs`, the same
			// file the literal named. `exports` has no `./dist/*` subpath, so the ROOT specifier is
			// the only one that reaches it.
			{
				find: /^onnxruntime-web\/webgpu$/,
				replacement: resolveModulePath("onnxruntime-web"),
			},
		],
	},
	test: {
		// isolate: false — a shared module graph per worker. Measured 2026-08-01: core+neural slice
		// 8m23s → 1m30s (5.6×), full sweep 4m48s wall. Every test file used to re-transform and
		// re-import the entire aliased workspace graph on its own; now each fork pays that once.
		// The old isolate:true justification (libpostal's top-level await breaking `class extends`
		// under a shared graph) no longer reproduces — #481 made the libpostal resource a lazy
		// getter, and the structural bare/subpath interleave is covered by the side-effect
		// `import "@mailwoman/core"` workaround in the affected files (see AGENTS.md).
		//
		// The shared-graph contract: `vi.mock` factories are only consulted at module EVALUATION,
		// so a module already cached by an earlier file in the same fork is returned as-is — mocks
		// declared against it silently never apply. Any file that mocks a shared module MUST call
		// `vi.resetModules()` before importing the module under test (reference:
		// resolver-wof-sqlite/lookup-readonly-open.test.ts, neural/web-loader.tolerance.test.ts).
		isolate: false,
		testTimeout: 15_000,
		coverage: {
			// `reportOnFailure` defaults to false, which means ONE failing test suppresses the entire report — and the
			// symptom is an empty coverage directory, which reads as "coverage is broken" rather than "a test failed".
			// A run that measured 64.45% statements on the unit leg is worth keeping when a suite goes red.
			reportOnFailure: true,
		},
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
			// pick them up and crash on the unfamiliar `test.describe` API. (The build/ entry
			// — the `docusaurus build` health gate — was missing here, so it surfaced the moment CI
			// could reach the test phase again.)
			"**/docs/test/browser/**",
			"**/docs/test/build/**",
			"**/docs/test/e2e/**",
			// Agent worktrees under .claude/worktrees/ are isolated git checkouts; each contains a
			// full copy of the repo's test files. Without this exclude, vitest descends into every
			// active worktree and runs every test suite N×(worktree count) times.
			"**/.claude/worktrees/**",
			// `corpus-python/.venv` is a Python virtualenv that vendors a Svelte app (trackio) carrying
			// its own *.test.js files. Vitest collected five of them; they normally surface as an
			// unexplained `1 skipped`, and at `--maxWorkers=4` one FAILED the run outright with "No test
			// suite found in file .../legend.test.js". CI never saw it — .venv is not checked in, so a
			// fresh checkout collects 316 files against a working tree's 321 — but it is a real local
			// and agent-worktree flake, and the failure mode is a red run nobody can attribute.
			"**/.venv/**",
			// scratchpad/ holds staged release trees, probe output, and copied source. Same class: not
			// checked in, so invisible to CI, and a landmine locally.
			"**/scratchpad/**",
			// @mailwoman/react's tests are Vitest BROWSER MODE only (playwright/chromium via the
			// workspace's own vitest.config.ts + `test:browser`). Importing vitest/browser inside
			// this root forks-pool sweep is a hard error ("can be imported only inside the Browser
			// Mode"), which is exactly what broke CI's Test leg from #1215 onward. CI runs the
			// browser leg as its own step (test.yml "Test react (browser mode)").
			"**/react/**/*.test.{ts,tsx}",
		],
	},
})
