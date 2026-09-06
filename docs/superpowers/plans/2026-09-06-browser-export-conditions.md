# Browser Export Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `@mailwoman/*` subpath the browser client reaches bundle under the `browser` condition with no Node builtin in its static graph, so `docs/plugins/demo-assets/webpack-policy.ts` needs no stub, shim or fallback for `@mailwoman/*`.

**Architecture:** Two packaging defects account for every stub. `@mailwoman/core/objects` imports one predicate from the `spliterator` barrel, which drags that library's Node fs, worker-thread and XLSX readers into the client; the fix is a local predicate. `@mailwoman/neural`'s classifier lazily imports `#classifier/loader`, the Node weights loader, and `webpackIgnore` hides that only from webpack; the fix is a `browser` condition on that `imports` entry pointing at a refusing module. A table-driven esbuild test pins both, then the docs plugin loses its stubs and the docs build proves it.

**Tech Stack:** TypeScript under Node type stripping, esbuild (already a devDependency of `core` and `neural` at 0.28.2), vitest (the `unit-slow` CI leg runs `packages/*/test/integration/**`), Docusaurus 3 with webpack, Playwright for the docs browser suite.

**Spec:** `docs/superpowers/specs/2026-09-06-browser-export-conditions-design.md`

## Global Constraints

- The fix lives in the owning package: a `browser` export or import condition, never a new package, never a bundler shim in a published package.
- A moved name gets no compatibility re-export.
- Done means `webpack-policy.ts` carries zero `node:` stubs and zero client-side aliases for `@mailwoman/*`; the Earth `vite.config.ts` will carry no `resolve.alias` for `@mailwoman/*`.
- `node:*` imports are permitted only under `packages/core/lib/fs/`; `oxlint.config.ts` refuses them elsewhere. No task adds one.
- A test imports the package under test through its public exports; never through a `#` specifier; a relative import names only a helper under `test/`.
- `process.env` and `process.argv` are never read directly.
- Comments state invariants, not history: no dates, issue numbers or "moved from" narration in code.
- Every commit passes the pre-commit hook (oxlint + oxfmt on staged files). Run `yarn compile` before any test that resolves `default` exports, because those resolve to `out/`.
- Branch from `origin/main`: `git fetch origin main && git checkout -b feat/browser-export-conditions origin/main`.

## The inventory (already run, paste into the PR description)

Measured 2026-09-06 at `17d2ff958` with esbuild, `platform: "browser"`, `conditions: ["browser"]`, `bundle: true`, over every `@mailwoman/*` specifier the docs client imports statically or dynamically (28 subpaths). "Static" counts builtin imports reachable through static import chains only; "all" also follows dynamic imports.

| Subpath                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Static builtin imports | All builtin imports | Chain                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mailwoman/core/objects`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 7                      | 20                  | `objects.js` → `spliterator/out/index.js` → `AsyncSpliterator.js`, `segment-workers.js`, `parallel-map-workers.js`, `io/writer.js`, `XLSXSpliterator.js` (`node:worker_threads`, `node:stream/web`, `stream/web`, `node:fs`, `node:url`, `node:stream`)                                 |
| `@mailwoman/neural/web-loader`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 0                      | 36                  | 34 through `classifier/index.js` → `import("#classifier/loader")` → `core/fs/readers`, `env-paths`, `core/module/resolvers`, `core/utils` barrel, `core/hash`, `core/process`; 2 node-guarded dynamic imports: `tokenizer.js` → `node:fs/promises`, `sentencepiece.mjs` → `node:module` |
| The other 26 (`react`, `react/map`, `spatial`, `core/json`, `core/resolver`, `core/decoder`, `core/decoder/types`, `core/errors`, `core/pipeline`, `resolver`, `resolver-wof-wasm/browser-cascade`, `resolver-wof-sqlite/{street/normalize,proximity-rerank,primary-preference,fts,candidate-schema,fst/autocomplete,fst/deserialize-web}`, `neural/viterbi`, `kind-classifier`, `phrase-grouper`, `query-shape`, `codex/us`, `cartographer`, `cartographer/base`, `cartographer/coverage`) | 0                      | 0                   | clean                                                                                                                                                                                                                                                                                   |

The `read-excel-file/node` and `write-excel-file/node` aliases in `webpack-policy.ts` are the XLSX reader on the `core/objects` chain; they leave with it. The `@mailwoman/neural/onnx-runner` and `#onnx-runner` aliases apply to the SSR bundle only (`bundleAliases(isServer = true)`), which is a Docusaurus property and leaves with the geocoder page in the Earth plan; Task 6 amends the spec to say so.

---

### Task 1: The browser bundle test, failing

**Files:**

- Create: `packages/neural/test/integration/browser-bundle.test.ts`

**Interfaces:**

- Consumes: `@mailwoman/core/module/resolvers` `resolvePackagePath(name)`; `esbuild` `build()` with `metafile: true`.
- Produces: the test rows later tasks turn green. Task 3 relies on the row for `@mailwoman/neural/classifier` asserting `out/classifier/loader-browser.js` is in the bundle and `out/classifier/loader.js` is not.

The test lives in `neural` rather than one file per package because `neural` depends on `core`, both packages' subpaths are public exports, and a second copy of the esbuild walk in `core/test/` would trip `jscpd` (`minTokens: 80`). The existing `packages/core/test/integration/worker-bundle.test.ts` keeps its own shape; it asserts a different condition set.

- [ ] **Step 1: Write the test**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every subpath the browser client reaches must bundle under the `browser` condition with no Node builtin on a static
 *   import chain. A bundler resolves `exports` and `imports` under `browser` before `default`; this test bundles the same
 *   way, reads the metafile, and walks only the edges a static `import` creates. A `node:` specifier on that walk is a
 *   package whose browser half is missing, and the fix is a `browser` condition in the owning package, never a stub in
 *   the consumer's bundler config.
 *
 *   Dynamic imports of a builtin are tolerated ONLY when listed with a reason: each is a Node-only branch behind a
 *   runtime guard, and the list is the whole allowance. A new one fails here until it is either removed or listed.
 *
 *   Resolution goes to `out/`, which is what a consumer bundles. Run `yarn compile` first.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { build, type Metafile } from "esbuild"
import { describe, expect, test } from "vitest"

const NODE_BUILTINS = [
	"assert",
	"async_hooks",
	"buffer",
	"child_process",
	"constants",
	"crypto",
	"diagnostics_channel",
	"dns",
	"events",
	"fs",
	"fs/promises",
	"http",
	"https",
	"inspector",
	"module",
	"net",
	"os",
	"path",
	"perf_hooks",
	"process",
	"querystring",
	"readline",
	"stream",
	"stream/promises",
	"stream/web",
	"string_decoder",
	"timers",
	"timers/promises",
	"tls",
	"tty",
	"url",
	"util",
	"v8",
	"vm",
	"wasi",
	"worker_threads",
	"zlib",
] as const

const THIRD_PARTY_EXTERNAL = [
	"react",
	"react/*",
	"react-dom",
	"react-dom/*",
	"onnxruntime-web",
	"onnxruntime-web/*",
	"onnxruntime-node",
	"maplibre-gl",
	"sql.js-httpvfs",
	"@sqlite.org/*",
] as const

interface AllowedDynamicImport {
	file: RegExp
	builtin: string
	reason: string
}

const ALLOWED_DYNAMIC_IMPORTS: readonly AllowedDynamicImport[] = [
	{
		file: /neural\/out\/tokenizer\.js$/u,
		builtin: "node:fs/promises",
		reason: "loadFromFile is Node-only; the import runs only when it is called",
	},
	{
		file: /sentencepiece-wasm\/sentencepiece\.mjs$/u,
		builtin: "node:module",
		reason: "the emscripten preamble's Node branch, behind its own environment check",
	},
]

interface Row {
	specifier: string
	/** Files that must be in the bundle, named by a suffix of their metafile path. */
	mustInclude?: readonly RegExp[]
	/** Files that must NOT be in the bundle. */
	mustExclude?: readonly RegExp[]
}

const ROWS: readonly Row[] = [
	{ specifier: "@mailwoman/core/objects" },
	{ specifier: "@mailwoman/core/json" },
	{ specifier: "@mailwoman/core/resolver" },
	{ specifier: "@mailwoman/core/decoder" },
	{ specifier: "@mailwoman/core/decoder/types" },
	{ specifier: "@mailwoman/core/errors" },
	{ specifier: "@mailwoman/core/pipeline" },
	{ specifier: "@mailwoman/neural/viterbi" },
	{ specifier: "@mailwoman/neural/web-loader" },
	{
		specifier: "@mailwoman/neural/classifier",
		mustInclude: [/neural\/out\/classifier\/loader-browser\.js$/u],
		mustExclude: [/neural\/out\/classifier\/loader\.js$/u],
	},
]

const isBuiltin = (specifier: string): boolean =>
	specifier.startsWith("node:") || (NODE_BUILTINS as readonly string[]).includes(specifier)

async function bundleForBrowser(specifier: string): Promise<Metafile> {
	const result = await build({
		stdin: {
			contents: `import "${specifier}"`,
			resolveDir: String(resolvePackagePath("@mailwoman/neural")),
			sourcefile: "browser-entry.ts",
			loader: "ts",
		},
		bundle: true,
		format: "esm",
		platform: "browser",
		conditions: ["browser"],
		mainFields: ["browser", "module", "main"],
		target: "es2022",
		write: false,
		metafile: true,
		logLevel: "silent",
		external: [...NODE_BUILTINS.map((name) => `node:${name}`), ...NODE_BUILTINS, ...THIRD_PARTY_EXTERNAL],
	})

	return result.metafile
}

/** A file the walk reached is always in the metafile; a miss is an esbuild contract change, not an empty import list. */
function inputOf(metafile: Metafile, file: string): Metafile["inputs"][string] {
	const input = metafile.inputs[file]
	if (!input) throw new Error(`metafile has no input for ${file}`)

	return input
}

/** Every input reachable from the entry through static imports alone. */
function staticallyReached(metafile: Metafile): Set<string> {
	const entry = Object.keys(metafile.inputs).find((path) => path.endsWith("browser-entry.ts"))
	if (!entry) throw new Error("esbuild metafile has no entry input")

	const reached = new Set<string>([entry])
	const queue = [entry]

	// A for-of over an array visits elements pushed during the loop, so this is the breadth-first walk.
	for (const current of queue) {
		for (const edge of inputOf(metafile, current).imports) {
			if (edge.external || edge.kind === "dynamic-import" || reached.has(edge.path)) continue
			reached.add(edge.path)
			queue.push(edge.path)
		}
	}

	return reached
}

interface BuiltinEdge {
	file: string
	builtin: string
	kind: string
}

function builtinEdges(metafile: Metafile, reached: Set<string>): BuiltinEdge[] {
	const edges: BuiltinEdge[] = []

	for (const file of reached) {
		for (const edge of inputOf(metafile, file).imports) {
			if (isBuiltin(edge.path)) edges.push({ file, builtin: edge.path, kind: edge.kind })
		}
	}

	return edges
}

describe("browser client subpaths bundle under the browser condition", () => {
	test.each(ROWS)("$specifier", async ({ specifier, mustInclude = [], mustExclude = [] }) => {
		const metafile = await bundleForBrowser(specifier)
		const reached = staticallyReached(metafile)
		const edges = builtinEdges(metafile, reached)

		const staticEdges = edges
			.filter((edge) => edge.kind !== "dynamic-import")
			.map((edge) => `${edge.file} → ${edge.builtin}`)
		expect(staticEdges, `Node builtins on a static chain from ${specifier}:\n${staticEdges.join("\n")}`).toEqual([])

		const unlistedDynamic = edges
			.filter((edge) => edge.kind === "dynamic-import")
			.filter(
				(edge) =>
					!ALLOWED_DYNAMIC_IMPORTS.some((allowed) => allowed.file.test(edge.file) && allowed.builtin === edge.builtin)
			)
			.map((edge) => `${edge.file} → ${edge.builtin}`)
		expect(
			unlistedDynamic,
			`dynamic builtin imports not on the allowance list:\n${unlistedDynamic.join("\n")}`
		).toEqual([])

		const inputs = Object.keys(metafile.inputs)
		for (const pattern of mustInclude)
			expect(
				inputs.some((path) => pattern.test(path)),
				`bundle lacks ${pattern}`
			).toBe(true)
		for (const pattern of mustExclude)
			expect(
				inputs.some((path) => pattern.test(path)),
				`bundle carries ${pattern}`
			).toBe(false)
	})
})
```

- [ ] **Step 2: Compile and run the test to verify it fails on exactly two rows**

Run:

```bash
yarn compile
yarn vitest --run --config vitest.slow.config.ts packages/neural/test/integration/browser-bundle.test.ts
```

Expected: 8 rows pass, 2 fail. `@mailwoman/core/objects` fails on the static-chain assertion listing seven `spliterator` edges (`node:worker_threads`, `stream/web`, `node:stream/web`, `node:url`, `node:stream`, `node:fs`, `node:worker_threads`). `@mailwoman/neural/classifier` fails on `mustInclude` because `loader-browser.js` does not exist yet. If `@mailwoman/neural/web-loader` also fails on the dynamic allowance, the failing line names the file; it should not, since both dynamic imports are listed.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/neural/test/integration/browser-bundle.test.ts
git commit -m "test(neural): browser-condition bundle test over the client subpaths (two rows red)"
```

---

### Task 2: `@mailwoman/core/objects` stops importing the `spliterator` barrel

**Files:**

- Modify: `packages/core/lib/objects.ts:9` (the import) and `:115` (the one call site)
- Test: `packages/neural/test/integration/browser-bundle.test.ts` (row `@mailwoman/core/objects`)

**Interfaces:**

- Produces: `export function isIterable(value: unknown): value is Iterable<unknown>` from `@mailwoman/core/objects`, with the same semantics as spliterator's (`Symbol.iterator in new Object(input)`: a string answers true, `null` and `undefined` answer false).

- [ ] **Step 1: Replace the import with a local predicate**

In `packages/core/lib/objects.ts`, delete line 9 (`import { isIterable } from "spliterator"`) and add, below the `type-fest` import and above `isPlainObject`:

```ts
/**
 * True when `value` carries `Symbol.iterator`: arrays, sets, maps, strings, generators. `null` and `undefined` answer
 * false. The same predicate exists in `spliterator`, whose barrel also carries that library's Node fs, worker-thread
 * and XLSX readers; this module is on the browser client's static import path, so it must not reach that barrel.
 */
export function isIterable(value: unknown): value is Iterable<unknown> {
	return Symbol.iterator in new Object(value)
}
```

Line 115 (`const keys = isIterable(constraints) ? Array.from(constraints) : Object.values(constraints)`) is unchanged.

- [ ] **Step 2: Compile, lint, and run the row**

Run:

```bash
yarn compile
yarn oxlint packages/core/lib/objects.ts
yarn vitest --run --config vitest.slow.config.ts packages/neural/test/integration/browser-bundle.test.ts -t "core/objects"
```

Expected: oxlint reports nothing; the row passes with zero static edges. If `prefer-home` reports the predicate, the `HELPER_HOMES` row it names is the home to import from instead; there is none today.

- [ ] **Step 3: Run core's own unit tests for the module**

Run: `yarn vitest --run --config vitest.fast.config.ts packages/core/test/unit`

Expected: the same count of passing files as on `main` (run the same command on `main` first if the count is not already known).

- [ ] **Step 4: Commit**

```bash
git add packages/core/lib/objects.ts
git commit -m "fix(core): objects no longer imports the spliterator barrel, which put seven node: builtins on the browser path"
```

---

### Task 3: `#classifier/loader` gets a `browser` condition

**Files:**

- Create: `packages/neural/lib/classifier/loader-browser.ts`
- Modify: `packages/neural/package.json` (`imports`, add `"#classifier/loader"` beside the existing `"#onnx-runner"` entry)
- Modify: `packages/neural/lib/classifier/index.ts:201-227` (the two docstrings)
- Test: `packages/neural/test/integration/browser-bundle.test.ts` (rows `@mailwoman/neural/classifier`, `@mailwoman/neural/web-loader`)

**Interfaces:**

- Consumes: `loadClassifierFromWeights` and `loadScriptRoutedClassifier` types from `#classifier/loader` (the Node module; tsc resolves `#classifier/loader` through the `node` condition to `lib/classifier/loader.ts`, so the `typeof import(...)` positions in `index.ts` keep the Node signatures).
- Produces: a browser half of `#classifier/loader` exporting the same two names, each throwing at call time.

- [ ] **Step 1: Write the browser half**

`packages/neural/lib/classifier/loader-browser.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The browser half of `#classifier/loader`. The Node half reads weights from disk through `@mailwoman/core/fs`,
 *   resolves them through `node:module`, and runs them on `onnxruntime-node`; none of that has a browser meaning. A
 *   bundler that follows `NeuralAddressClassifier.loadFromWeights` under the `browser` condition lands here and gets a
 *   refusal at call time instead of the Node graph at bundle time. Browser callers load through `web-loader`.
 */

import type {
	loadClassifierFromWeights as loadClassifierFromWeightsNode,
	loadScriptRoutedClassifier as loadScriptRoutedClassifierNode,
} from "#classifier/loader"

function refuse(name: string): never {
	throw new Error(
		`${name} reads weights from the filesystem and has no browser implementation; load through @mailwoman/neural/web-loader`
	)
}

export const loadClassifierFromWeights: typeof loadClassifierFromWeightsNode = () => refuse("loadClassifierFromWeights")

export const loadScriptRoutedClassifier: typeof loadScriptRoutedClassifierNode = () =>
	refuse("loadScriptRoutedClassifier")
```

- [ ] **Step 2: Add the conditional `imports` entry**

In `packages/neural/package.json`, inside `"imports"`, add this entry (an exact key wins over the `"#*"` pattern regardless of position; place it next to `"#onnx-runner"`, whose shape it copies):

```json
"#classifier/loader": {
	"browser": "./out/classifier/loader-browser.js",
	"node": "./lib/classifier/loader.ts",
	"default": "./out/classifier/loader.js",
	"types": "./out/classifier/loader.d.ts"
},
```

`yarn pack` already rewrites `imports` for publish (`packages/release-kit/lib/pack/pack-workspace.ts`, `transformImportsForPublish`), so the `node → .ts` condition is stripped from the tarball the same way `#onnx-runner`'s is.

- [ ] **Step 3: Update the two docstrings in `classifier/index.ts`**

Replace the paragraph at lines 201-206 with:

```ts
/**
 * One-call factory — see `classifier-loader.ts`, where the whole resolution lives.
 *
 * **Node-only.** `#classifier/loader` carries a `browser` condition that resolves to a refusing module, so a browser
 * bundle that follows this import stays free of `onnxruntime-node` and the fs-reading weights resolver, and calling
 * it there throws. The `webpackIgnore` comment keeps webpack's SSR bundle from following the Node half. Browser
 * callers use `loadNeuralClassifierFromURLs`.
 */
```

Leave the two `import(/* webpackIgnore: true */ "#classifier/loader")` lines as they are. The comment is for the docs SSR bundle, which resolves the `node` condition and would otherwise bundle the Node loader.

- [ ] **Step 4: Compile, lint, run the rows**

Run:

```bash
yarn compile
yarn oxlint packages/neural/lib/classifier/loader-browser.ts packages/neural/lib/classifier/index.ts
yarn vitest --run --config vitest.slow.config.ts packages/neural/test/integration/browser-bundle.test.ts
```

Expected: all 10 rows pass. The `classifier` row's bundle contains `neural/out/classifier/loader-browser.js` and not `neural/out/classifier/loader.js`.

- [ ] **Step 5: Prove Node still loads through the real loader**

Run: `yarn vitest --run --config vitest.slow.config.ts packages/neural/test`

Expected: the same pass count as on `main` (the fast CI leg excludes `neural/test/**`, so the slow config is the one that runs them; it needs the lab's weights and databases). Then, from the repository root, `node -e 'import("@mailwoman/neural/classifier").then((m) => console.log(typeof m.NeuralAddressClassifier.loadFromWeights))'` prints `function`.

- [ ] **Step 6: Commit**

```bash
git add packages/neural/lib/classifier/loader-browser.ts packages/neural/package.json packages/neural/lib/classifier/index.ts
git commit -m "feat(neural): #classifier/loader resolves to a refusing module under the browser condition"
```

---

### Task 4: The docs plugin loses its stubs

**Files:**

- Modify: `docs/plugins/demo-assets/webpack-policy.ts` (delete `NODE_BUILTIN_SHIMS`, `EMPTY_NODE_BUILTINS`, `fallbackMap`, the `NormalModuleReplacementPlugin`, the two `*-excel-file/node` aliases, the `emptyShim` parameter)
- Modify: `docs/plugins/demo-assets/plugin.ts:18,23-24,50` (drop `emptyShim`)
- Delete: `docs/plugins/demo-assets/node-builtin-stubs.js`, `docs/plugins/demo-assets/node-path-shim.js`, `docs/src/empty-shim.js`
- Modify: `packages/neural/test/integration/browser-slo.test.ts` (the header paragraph that says the loader "needs the node-builtin shim policy the docs site keeps in `docs/plugins/demo-assets/`")

**Interfaces:**

- Produces: `bundleAliases(isServer: boolean): Promise<Record<string, string>>` and `configureDemoWebpack(config, alias, isServer): Configuration`.

- [ ] **Step 1: Rewrite `webpack-policy.ts`**

The whole file becomes:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Browser/SSR bundle policy for the geocoder page.
 *
 *   What remains here is Docusaurus-specific: the workspace source aliases for development, the SSR bundle's
 *   externals, the WASM asset rule, and a cache key that follows the alias map. Module resolution for `@mailwoman/*`
 *   is NOT rewritten here: a package the client reaches carries a `browser` export condition, and
 *   `packages/neural/test/integration/browser-bundle.test.ts` refuses a Node builtin on the client's static path.
 */

import { md5Hex } from "@mailwoman/core/hash"
import type { Configuration } from "webpack"

import { buildWorkspaceAliases } from "./workspace-aliases.ts"
import { resolvePackageFile } from "./workspace-resolution.ts"

function hashAliases(alias: Record<string, string>): string {
	const entries = Object.keys(alias)
		.toSorted()
		.map((key) => `${key}=${alias[key]}`)

	return md5Hex(entries.join("\n"))
}

export async function bundleAliases(isServer: boolean): Promise<Record<string, string>> {
	const alias = await buildWorkspaceAliases()

	if (isServer) {
		// The SSR bundle resolves the `node` condition, under which `@mailwoman/neural/onnx-runner` is the
		// `onnxruntime-node` half, which webpack cannot bundle. The page is browser-only; the server bundle only has to
		// build, so it takes the browser runner.
		const browserRunner = await resolvePackageFile("@mailwoman/neural", "onnx-runner-browser")

		if (browserRunner) {
			alias["@mailwoman/neural/onnx-runner"] = browserRunner
			alias["#onnx-runner"] = browserRunner
		}
	}

	return alias
}

function filesystemCache(config: Configuration, alias: Record<string, string>): Pick<Configuration, "cache"> {
	const baseCache = config.cache

	if (typeof baseCache !== "object" || baseCache?.type !== "filesystem") return {}

	return {
		cache: { type: "filesystem", version: `${baseCache.version ?? ""}-${hashAliases(alias)}` },
	}
}

/**
 * Docusaurus calls `configureWebpack` SYNCHRONOUSLY, so the alias map is resolved by the caller — the plugin factory,
 * which Docusaurus does await — and handed in here. Resolving it at this point would return a promise the lifecycle
 * never unwraps.
 */
export function configureDemoWebpack(
	config: Configuration,
	alias: Record<string, string>,
	isServer: boolean
): Configuration {
	return {
		...filesystemCache(config, alias),
		// isomorphic-dompurify's Node build constructs a jsdom window at import, and jsdom cannot be webpack-bundled
		// (`__dirname is not defined` inside the SSR bundle). The server bundle requires the real package from
		// node_modules at render time instead, so SSR sanitizes through the same jsdom-backed engine as any other Node
		// process. The client bundle keeps bundling it — the package's `browser` build, plain DOMPurify.
		...(isServer ? { externals: [{ "isomorphic-dompurify": "commonjs isomorphic-dompurify" }] } : {}),
		resolve: {
			alias,
			extensionAlias: { ".js": [".ts", ".js"] },
		},
		module: { rules: [{ test: /[.]wasm$/, type: "asset/resource" }] },
	}
}
```

- [ ] **Step 2: Update `plugin.ts` and delete the three shim files**

First confirm the three files have no other consumer:

```bash
grep -rn "empty-shim\|node-builtin-stubs\|node-path-shim" docs --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' -l | grep -v node_modules
```

Expected: only `docs/plugins/demo-assets/webpack-policy.ts` and `docs/plugins/demo-assets/plugin.ts`. Any other file is a consumer to rewrite before the delete.

In `docs/plugins/demo-assets/plugin.ts`: delete line 18 (`const emptyShim = …`); change lines 23-24 to `client: await bundleAliases(false),` and `server: await bundleAliases(true),`; change line 50 to `return configureDemoWebpack(config, isServer ? aliases.server : aliases.client, isServer)`. If `resolvePath` has no other use in the file after the deletion, remove it from the import.

```bash
git rm docs/plugins/demo-assets/node-builtin-stubs.js docs/plugins/demo-assets/node-path-shim.js docs/src/empty-shim.js
```

- [ ] **Step 3: Rewrite the stale paragraph in `browser-slo.test.ts`**

Replace the sentence beginning "Bundling THAT needs the node-builtin shim policy the docs site keeps in `docs/plugins/demo-assets/`" and the sentence after it with:

```text
 *   Bundling THAT is what `browser-bundle.test.ts` proves; this harness keeps the reduced graph because its subject is
 *   timing, and the two node imports the reduced graph does meet (`node:fs/promises` in the tokenizer's `loadFromFile`,
 *   `node:module` in the emscripten preamble) are DYNAMIC and node-guarded, so marking them external is the entire
 *   accommodation.
```

- [ ] **Step 4: Build the docs site**

Run:

```bash
yarn compile
cd docs && yarn build > /tmp/docs-build.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build.log; tail -5 /tmp/docs-build.log; grep -n "Module not found\|Can't resolve\|node:" /tmp/docs-build.log | head
```

Expected: `EXIT=0` and no `Can't resolve` line. Read the log's `EXIT` line, not the exit of the pipe. If the build fails on a `node:` request, the failing module is a new inventory row: fix it in its package under one of the spec's three shapes and add a row to the bundle test. Do not reintroduce a fallback.

- [ ] **Step 5: Run the geocoder page's browser suite**

Run, from `docs/`:

```bash
yarn test:e2e --project=chromium test/browser/100-demo-cold-load.spec.ts test/browser/200-demo-resolve.spec.ts
```

Expected: PASS. `100-demo-cold-load` asserts the page hydrates without style, terrain or asset errors, which is where a missing module surfaces at runtime rather than at build time.

- [ ] **Step 6: Commit**

```bash
git add docs/plugins/demo-assets/webpack-policy.ts docs/plugins/demo-assets/plugin.ts packages/neural/test/integration/browser-slo.test.ts
git commit -m "chore(docs): the geocoder page bundles with no node: stub, shim or fallback for @mailwoman/*"
```

---

### Task 5: Retry the rspack bundler

**Files:**

- Modify: `docs/docusaurus.config.ts:93-103`

- [ ] **Step 1: Enable it**

Change `rspackBundler: false` to `rspackBundler: true`. Leave `rspackPersistentCache: false`.

- [ ] **Step 2: Build**

Run, from `docs/`:

```bash
yarn build > /tmp/docs-build-rspack.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build-rspack.log; tail -5 /tmp/docs-build-rspack.log
```

- [ ] **Step 3: Record the result, either way**

If `EXIT=0`: replace the comment at lines 94-97 with

```ts
// rspack bundles the site now that every @mailwoman/* subpath the client reaches carries a browser condition;
// the persistent cache stays off until a build has been measured with it.
```

and run Task 4 Step 5 again against the rspack build. Expected: PASS.

If the build fails: set `rspackBundler` back to `false` and replace the comment with the module the log names, in this shape:

```ts
// rspack refuses <module> (<error text>), so webpack stays in charge; the other speedups (swc loader /
// minimizer, lightningcss, mdx cache) stay on.
```

- [ ] **Step 4: Commit**

```bash
git add docs/docusaurus.config.ts
git commit -m "chore(docs): rspack bundler retried after the browser-condition fixes"
```

with the outcome (kept on, or the refusing module) stated in the commit body.

---

### Task 6: Spec receipts and the release-side check

**Files:**

- Modify: `docs/superpowers/specs/2026-09-06-browser-export-conditions-design.md` (status line; the "Proof" section; the "Definition of done" list)

- [ ] **Step 1: Amend the spec**

Status line: append `Implemented`, today's date, and the PR number once `gh pr create` prints it.

"Proof" section: replace its first sentence with "One table-driven test, `packages/neural/test/integration/browser-bundle.test.ts`, covers every `core` and `neural` subpath the client reaches; `neural` depends on `core`, so both packages' public subpaths are reachable from one file, and a second copy of the esbuild walk would trip `jscpd`. Subpaths in packages `neural` does not depend on (`react`, `spatial`, `cartographer`, `resolver-wof-wasm`, `resolver-wof-sqlite`) measured clean and are guarded by the Earth app's Vite build."

"Definition of done", second bullet: replace with "`docs/plugins/demo-assets/webpack-policy.ts` carries zero `node:` stubs, zero fallbacks, and zero client-side aliases for `@mailwoman/*`. The SSR-only `onnx-runner` alias is a Docusaurus property and leaves with the geocoder page in the Earth design."

- [ ] **Step 2: Run the full preflight**

Run, from the repo root:

```bash
yarn health > /tmp/health.log 2>&1; echo "EXIT=$?" >> /tmp/health.log; grep -n "error\|EXIT" /tmp/health.log | head
yarn typecheck:tests
yarn ci:test:fast
```

Expected: `health` exits 0 (if `health:debt` reports `asNever` or `doubleCast` growth, check whether `main` already fails the same way before touching the baseline; the baseline is not this change's to move). `typecheck:tests` and the fast test leg pass.

- [ ] **Step 3: Commit and open the PR**

```bash
git add docs/superpowers/specs/2026-09-06-browser-export-conditions-design.md
git commit -m "docs(specs): browser export conditions — implemented, receipts recorded"
git push -u origin feat/browser-export-conditions
gh pr create --title "Browser export conditions: retire the docs bundler stubs in the owning packages" --body-file <(cat <<'EOF'
Implements docs/superpowers/specs/2026-09-06-browser-export-conditions-design.md.

## Inventory (esbuild, platform browser, conditions ["browser"], 28 client subpaths)

<paste the inventory table from docs/superpowers/plans/2026-09-06-browser-export-conditions.md>

## What changed

- @mailwoman/core/objects: a local isIterable; the spliterator barrel is off the client path (7 static node: edges → 0)
- @mailwoman/neural: #classifier/loader carries a browser condition → classifier/loader-browser.ts (34 node: edges behind the lazy import → 0 in the browser bundle)
- packages/neural/test/integration/browser-bundle.test.ts: 10 rows, static-chain assertion plus a two-entry dynamic allowance
- docs/plugins/demo-assets/webpack-policy.ts: 5 shims, 9 empty builtins, 2 excel aliases, the NormalModuleReplacementPlugin and the fallback map deleted; 3 shim files removed
- rspack: <kept on | refuses <module>>

## Verification

- docs build EXIT=0; 100-demo-cold-load and 200-demo-resolve pass
- yarn health, typecheck:tests, ci:test:fast

https://claude.ai/code/session_01ADYjzV88cHb94MRW4Dn1Aq
EOF
)
```

The PR is the receipt the spec's first done bullet asks for; the inventory table goes in its description, not in a comment in code.
