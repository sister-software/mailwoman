# Earth Runtime Homes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every browser-runtime module under `docs/src/shared/` moves to the package that owns it, the docs site consumes the packages and still serves the geocoder page unchanged, and the result contract the runtime produces and the UI renders is written once. After this plan the docs site owns no runtime module; the second runtime plan mounts the real runtime in `packages/earth` and retires the docs page.

**Architecture:** Four homes. `@mailwoman/core/pipeline/client-result` holds the parse-result contract that `@mailwoman/react` renders and the loader produces (today written twice, as react's `ParseResult` and docs' `DemoResult`). `@mailwoman/resolver-wof-wasm/httpvfs/*` holds the sql.js-httpvfs readers, their tests, and the host-side asset staging. `mailwoman/browser-runtime/*` holds the release manifest, the asset URL composition and version pins, the classify stage, and the release-asset loader; `mailwoman` already depends on `neural` and `resolver-wof-wasm`, so it is the one package that can compose them, and the version bump `mailwoman gazetteer publish` prints becomes package-local. `@mailwoman/react/common/*` holds the two presentation helpers. Nothing is copied: every move is a `git mv` followed by import rewrites, and every consumer imports the new home.

**Tech Stack:** TypeScript under Node type stripping; vitest (fast leg for core, react, mailwoman unit tests; slow leg where a test opens a SQLite fixture); the docs Docusaurus build and its two Playwright specs as the parity proof; `bundle-graph` for the browser condition on every new subpath.

**Spec:** `docs/superpowers/specs/2026-09-06-earth-app-design.md` ("The move map"). Three placements differ from the spec's table and are recorded in Task 8: the runtime assembly stays application code (react must not depend on the runtime graph), the loader lives in `mailwoman` rather than `neural` (it composes neural and the gazetteer), and the sql.js staging stays in docs because the docs explainers resolve against the gazetteer.

## Global Constraints

- A moved name gets no compatibility re-export: the old specifier stops resolving and every consumer imports the new home in the same commit.
- `@mailwoman/react` never depends on `neural`, `resolver-wof-wasm`, `cartographer` or `mailwoman`; it gains `@mailwoman/core` for the result contract, nothing else.
- `mailwoman` never depends on `@mailwoman/react`; the loader's progress interface is its own structural type.
- `@mailwoman/resolver-wof-wasm` never depends on `mailwoman` (cycle); a URL the reader needs is a parameter.
- A test imports the package under test through its public exports; a moved test moves with its module and gets an `exports` entry for what it names.
- Every new browser-reachable subpath gets a `bundle-graph` row in `packages/repo-health/lib/checks/bundle-graph.ts`.
- `node:*` imports only under `packages/core/lib/fs/`; filesystem work through `@mailwoman/core/fs`.
- Dependency ranges match existing declarations (`sherif`): `sql.js-httpvfs` `^0.8.12`.
- Comments state invariants, not history; the move is recorded in the commit, not in the file.
- The docs geocoder page keeps working after every task: `cd docs && yarn build` exits 0 and the two Playwright specs `100-demo-cold-load` and `200-demo-resolve` pass.
- Branch: `git fetch origin main && git checkout -b feat/earth-runtime-homes origin/main`. Land the shell plan first or rebase onto it; this plan does not touch `packages/earth`.

## Move map

| From `docs/src/shared/…`                                                                                         | To                                                                       | Task |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---- |
| `resources/index.ts` types `DemoResult`, `ResultNode`, `ResolvedHit`, `KindResult`, `StageTiming`                | `@mailwoman/core/pipeline/client-result` (merged with react's)           | 1    |
| `httpvfs-resolver.ts`, `httpvfs-street.ts`, `poi-httpvfs.ts`, `sqljs-rows.ts`; `demo-helpers.ts` `resolveStreet` | `@mailwoman/resolver-wof-wasm/httpvfs/{resolver,street,poi,rows}`        | 2    |
| `docs/plugins/demo-assets/artifacts.ts` `stageSQLJSHTTPVFS`, `syncArtifact`                                      | `@mailwoman/resolver-wof-wasm/host-assets`                               | 2    |
| `candidate-resolver-backend.ts` (no consumer; the live class is in `browser-cascade`)                            | deleted                                                                  | 2    |
| `resources/index.ts` URLs, pins, FST loaders, pair index; the `…Like` interfaces                                 | `mailwoman/browser-runtime/resources`, `mailwoman/browser-runtime/types` | 3    |
| `demo-helpers.ts` manifest half                                                                                  | `mailwoman/browser-runtime/manifest`                                     | 3    |
| `demo-helpers.ts` classify half, calibrator, defaults                                                            | `mailwoman/browser-runtime/classify`                                     | 3    |
| `demo-loader.ts`                                                                                                 | `mailwoman/browser-runtime/load-assets`                                  | 3    |
| `confidence-tiers.ts`, `text-tokens.ts`                                                                          | `@mailwoman/react/common/{confidence-tiers,text-tokens}`                 | 4    |
| `register-range-sw.ts`, `maplibre-worker*.ts`                                                                    | stay in docs until the second runtime plan                               | —    |

---

### Task 1: One result contract, in `@mailwoman/core/pipeline/client-result`

**Files:**

- Create: `packages/core/lib/pipeline/client-result.ts`
- Modify: `packages/core/package.json` (`exports["./pipeline/client-result"]`)
- Modify: `packages/react/lib/pipeline/types.ts` (delete the six moved interfaces; import what `PipelineRuntime` needs), `packages/react/lib/index.ts` (stop exporting the moved names), `packages/react/package.json` (dependency `@mailwoman/core`), `packages/react/tsconfig.json` (reference `../core`), the 11 files under `packages/react/lib` that import the moved names, and the react stories and tests that do
- Modify: `docs/src/shared/resources/index.ts` (delete `KindResult`, `ResultNode`, `StageTiming`, `DemoResult`, `ResolvedHit`), and the docs consumers of those five names and of react's `ParseResult` family
- Modify: `packages/repo-health/lib/checks/bundle-graph.ts` (one row)

**Interfaces:**

- Produces: `@mailwoman/core/pipeline/client-result` exporting `ParsedComponent`, `ResolvedPlaceView` (react's six fields plus docs' `bbox?`, `tier?: "address_point" | "interpolated"`, `uncertaintyM?`), `DualRoleView`, `StageTiming`, `FSTProvenance`, `KindView` (`{ kind, confidence, alternatives }`), `ParseResult` (react's fields plus docs' `stateHint?: string`). Task 3's classify stage returns `ParseResult`; react's `PipelineRuntime.runParse` resolves to it.

- [ ] **Step 1: Confirm the three shape questions with greps, and record the answers in the commit**

```bash
grep -n "stateHint" -r docs/src packages/react/lib | grep -v "resources/index.ts" | head
grep -n "export interface DualRole\b" -A8 packages/resolver-wof-wasm/lib/browser-cascade.ts
grep -n "export interface QueryKindResult" -A6 packages/core/lib/pipeline/types.ts
grep -n "export interface KindBadgeResult" -A6 packages/react/lib/common/KindBadge.tsx
```

Rules: if `stateHint` has a reader, `ParseResult` keeps it optional; if none, it is dropped. If `DualRole` (resolver side) and `DualRoleView` (UI side) carry the same five fields, `browser-cascade.ts` imports `DualRoleView` from core and `DualRole` is deleted; if they differ, both stay and `projectCascadeHits` in Task 3 maps one to the other explicitly. If `QueryKindResult` already is `{ kind, confidence, alternatives }`, `ParseResult.kindResult` is typed as it and no `KindView` is written; otherwise `KindView` is written with docs' three fields and `KindBadgeResult` in react becomes an alias-free import of it.

- [ ] **Step 2: Write the module**

`packages/core/lib/pipeline/client-result.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The parse result as a client renders it: what the browser runtime produces after classify + resolve, and what
 *   `@mailwoman/react` takes as input. One definition, because a producer and a renderer that each write the shape
 *   agree only by accident. Every field a stage may leave unset is optional here; a renderer that needs a value it
 *   cannot see shows absence, never a default.
 */

export interface ParsedComponent {
	tag: string
	value?: unknown
	confidence?: number
	start?: number
	end?: number
}

export interface ResolvedPlaceView {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
	score: number
	bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
	/**
	 * How the coordinate was reached when a street-tier lookup answered: a rooftop point, or an interpolation along
	 * the segment. Absent for a gazetteer place.
	 */
	tier?: "address_point" | "interpolated"
	uncertaintyM?: number
}

export interface DualRoleView {
	id: number
	name: string
	placetype: string
	relationshipType: string
	role: string
}

export interface StageTiming {
	shape: number
	classify: number
	resolve?: number
}

export interface FSTProvenance {
	builtAt: string
	stateCount: number
	placeCount: number
	importanceMatches: number
}

export interface KindView {
	kind: string
	confidence: number
	alternatives: ReadonlyArray<{ kind: string; confidence: number }>
}

export interface ParseResult {
	input: string
	/**
	 * The decoder's `AddressTree`, opaque here so this module stays free of the decoder's types; a renderer that walks
	 * it imports `@mailwoman/core/decoder/types`.
	 */
	tree: unknown
	nodes: ParsedComponent[]
	kindResult?: KindView
	timing?: StageTiming
	resolved: ResolvedPlaceView | null
	candidates: ResolvedPlaceView[]
	fstActive: boolean
	fstProvenance?: FSTProvenance | null
	dualRoles?: DualRoleView[]
}
```

Apply Step 1's answers (`stateHint`, `KindView` versus `QueryKindResult`) before saving. Add to `packages/core/package.json` `exports`, beside `"./pipeline/types"`:

```json
"./pipeline/client-result": {
	"node": "./lib/pipeline/client-result.ts",
	"default": "./out/pipeline/client-result.js",
	"types": "./out/pipeline/client-result.d.ts"
},
```

- [ ] **Step 3: React imports the contract instead of defining it**

In `packages/react/lib/pipeline/types.ts` delete `ParsedComponent`, `ResolvedPlaceView`, `DualRoleView`, `StageTiming`, `FSTProvenance`, `ParseResult` and add at the top:

```ts
import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
```

keeping `PipelineLoadingState`, `PipelineRuntime` and `PipelinePanels`, which are UI state. In `packages/react/lib/index.ts` remove the six names from the `export type { … } from "#pipeline/types"` block. Then rewrite every react importer:

```bash
grep -rln "ParsedComponent\|ResolvedPlaceView\|DualRoleView\|StageTiming\|FSTProvenance\|ParseResult" packages/react/lib packages/react/test --include='*.ts' --include='*.tsx' | grep -v "/out/"
```

For each file, the six names move from their `#pipeline/types` (or `./types.ts`, or `@mailwoman/react` in tests) import into `import type { … } from "@mailwoman/core/pipeline/client-result"`; a file that imported only those names drops the old import line. `packages/react/package.json` gains `"@mailwoman/core": "workspace:*"` in `dependencies` and `packages/react/tsconfig.json` gains `{ "path": "../core" }` in `references`.

- [ ] **Step 4: Docs imports the contract**

In `docs/src/shared/resources/index.ts` delete `KindResult`, `ResultNode`, `StageTiming`, `DemoResult`, `ResolvedHit`. Rewrite the docs consumers with this name map, each becoming an import from `@mailwoman/core/pipeline/client-result`:

| Old (docs)    | New (core)                                   |
| ------------- | -------------------------------------------- |
| `DemoResult`  | `ParseResult`                                |
| `ResultNode`  | `ParsedComponent`                            |
| `ResolvedHit` | `ResolvedPlaceView`                          |
| `KindResult`  | `KindView` (or `QueryKindResult` per Step 1) |
| `StageTiming` | `StageTiming`                                |

```bash
grep -rln "\bDemoResult\b\|\bResultNode\b\|\bResolvedHit\b\|\bKindResult\b\|\bStageTiming\b" docs/src docs/test --include='*.ts' --include='*.tsx'
grep -rln "ParseResult\|ResolvedPlaceView\|ParsedComponent\|DualRoleView\|FSTProvenance" docs/src docs/test --include='*.ts' --include='*.tsx' | xargs grep -ln 'from "@mailwoman/react"'
```

The second command lists the docs files that took those names from react; they switch to the core subpath. `docs/package.json` already depends on `@mailwoman/core`.

- [ ] **Step 5: The bundle-graph row, compile, tests, docs build**

Add `browserRow("@mailwoman/core/pipeline/client-result"),` after the `core/pipeline` row in `bundle-graph.ts`. Then:

```bash
yarn compile
yarn oxlint packages/core/lib/pipeline/client-result.ts packages/react docs/src
yarn mwops health bundle-graph
yarn workspace @mailwoman/react test:browser
yarn vitest --run --config vitest.fast.config.ts docs/test/unit packages/core/test/unit
cd docs && yarn typecheck && yarn build > /tmp/docs-build.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build.log; tail -3 /tmp/docs-build.log; cd -
```

Expected: every command passes; the docs build exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/react docs packages/repo-health
git commit -m "refactor(core,react,docs): the client parse result is one contract, core/pipeline/client-result"
```

---

### Task 2: The httpvfs readers and their tests move to `@mailwoman/resolver-wof-wasm`

**Files:**

- Move: `docs/src/shared/httpvfs-resolver.ts` → `packages/resolver-wof-wasm/lib/httpvfs/resolver.ts`; `httpvfs-street.ts` → `lib/httpvfs/street.ts`; `poi-httpvfs.ts` → `lib/httpvfs/poi.ts`; `sqljs-rows.ts` → `lib/httpvfs/rows.ts`
- Move: `docs/test/unit/src/shared/{httpvfs-resolver,candidate-parity,httpvfs-street}.test.ts` and `stub-worker.ts` → `packages/resolver-wof-wasm/test/unit/httpvfs/`
- Create: `packages/resolver-wof-wasm/lib/host-assets.ts` (from `docs/plugins/demo-assets/artifacts.ts` `syncArtifact` + `stageSQLJSHTTPVFS`)
- Delete: `docs/src/shared/candidate-resolver-backend.ts`
- Modify: `packages/resolver-wof-wasm/package.json` (exports, dependencies `@mailwoman/spatial`, `sql.js-httpvfs`), `packages/resolver-wof-wasm/tsconfig.json` (reference `../spatial`), `docs/src/shared/demo-helpers.ts` (`resolveStreet` leaves), `docs/plugins/demo-assets/artifacts.ts` and `plugin.ts`, the docs importers, `packages/repo-health/lib/checks/bundle-graph.ts`

**Interfaces:**

- Produces: `@mailwoman/resolver-wof-wasm/httpvfs/resolver` (`loadHTTPVFSDatabase`, `WOFHTTPVFSPlaceLookup`, `WOFCandidateTableLookup`, `makeHTTPVFSPolygonLookup`, `HTTPVFSWorker`, `DBWorkerFactory`, `HTTPSVFSOptions`); `…/httpvfs/street` (`HTTPVFSAddressPointLookup`, `HTTPVFSInterpolator`, `HTTPVFSDB`, `StreetPointHit`, `StreetInterpHit`, and `resolveStreet` with its `StreetResolution`); `…/httpvfs/poi` (`loadPOIWorker(poiDatabaseURL, sqljsBaseURL)`, `loadPOICategoryCodes`, `searchPOICategory`, `resolveAnchorCenter(gazetteerURL, sqljsBaseURL, anchorText)`, the types); `…/httpvfs/rows` (`rowsFromExec`, `tableExists`, `memoizeResettable`, `ExecResult`, `SQLExecutor`); `…/host-assets` (`stageSQLJSAssets(destDir): Promise<boolean>`, `syncArtifact`).

- [ ] **Step 1: Move the four modules and rewrite their imports**

```bash
mkdir -p packages/resolver-wof-wasm/lib/httpvfs
git mv docs/src/shared/httpvfs-resolver.ts packages/resolver-wof-wasm/lib/httpvfs/resolver.ts
git mv docs/src/shared/httpvfs-street.ts   packages/resolver-wof-wasm/lib/httpvfs/street.ts
git mv docs/src/shared/poi-httpvfs.ts      packages/resolver-wof-wasm/lib/httpvfs/poi.ts
git mv docs/src/shared/sqljs-rows.ts       packages/resolver-wof-wasm/lib/httpvfs/rows.ts
git rm docs/src/shared/candidate-resolver-backend.ts
```

In `resolver.ts`: `from "./resources"` becomes `from "#browser-cascade"` (both `DualRole` and `MailwomanLookupLike` are defined there; if Step 1 of Task 1 replaced `DualRole` with core's `DualRoleView`, import that from core); `from "./sqljs-rows.ts"` becomes `from "#httpvfs/rows"`; a `ResolvedHit` type becomes `ResolvedPlaceView` from `@mailwoman/core/pipeline/client-result`. In `street.ts`: `./sqljs-rows.ts` → `#httpvfs/rows`. In `poi.ts`: `./httpvfs-resolver.ts` → `#httpvfs/resolver`, `./sqljs-rows.ts` → `#httpvfs/rows`, and every value it took from `./resources/index.ts` (`poiLayerURL`, `adminGazetteerURL`, the `sqljsBaseURL` composition) becomes a parameter:

```ts
export async function loadPOIWorker(poiDatabaseURL: string, sqljsBaseURL: string): Promise<POIHTTPVFSWorker>
export async function resolveAnchorCenter(
	gazetteerURL: string,
	sqljsBaseURL: string,
	anchorText: string
): Promise<AnchorCenter | null>
```

so the package never reaches the URL table that lives in `mailwoman` (Task 3), which depends on this package. Read each moved file's header and rewrite any sentence that says it lives in the docs site.

- [ ] **Step 2: `resolveStreet` joins `street.ts`**

Move `resolveStreet` and `StreetResolution` (lines from `export interface StreetResolution` to the end of `resolveStreet`) out of `docs/src/shared/demo-helpers.ts` and append them to `packages/resolver-wof-wasm/lib/httpvfs/street.ts`. Its imports (`@mailwoman/spatial`, the lookups, `normalizeLocalityForKey`) are already in `street.ts` or are added from `demo-helpers.ts`'s import block. Add `"@mailwoman/spatial": "workspace:*"` to the package's `dependencies` and `{ "path": "../spatial" }` to its `tsconfig.json` references.

- [ ] **Step 3: Host assets**

`packages/resolver-wof-wasm/lib/host-assets.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a host must stage to serve the httpvfs readers: sql.js-httpvfs's UMD bundle, its worker and its WASM, loaded
 *   at run time by URL (the UMD via a classic script tag, the worker and WASM handed to `createDbWorker`), so no
 *   bundler ever sees them. Bundling sql.js-httpvfs is what produces "Critical dependency" warnings, so a host copies
 *   the three files into a static directory and passes that directory's URL as `sqljsBaseURL`. Node-side; a build
 *   step, never the browser.
 */

import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { copyFileTo, makeDirectories } from "@mailwoman/core/fs/writers"
import { tryResolvePackageSpecifier } from "@mailwoman/core/module/resolve-from"
import { dirname, resolvePath } from "path-ts"

export const SQLJS_RUNTIME_FILES = ["index.js", "sqlite.worker.js", "sql-wasm.wasm"] as const

/**
 * Copy `sourcePath` to `destPath` unless a file of the same size is already there. Idempotent by size so a dev server
 * watching the destination does not see a rewrite of identical bytes as a change.
 */
export async function syncArtifact(sourcePath: string, destPath: string): Promise<boolean> {
	const source = await statPath(sourcePath)

	if (await pathExists(destPath)) {
		const dest = await statPath(destPath)
		if (dest.size === source.size) return false
	}

	await copyFileTo(sourcePath, destPath)

	return true
}

/**
 * Stage sql.js-httpvfs's three runtime files into `destDir`. Returns false, having warned, when the package or a file
 * is not resolvable, because a missing worker is a page that loads and cannot resolve, which must be visible at build.
 */
export async function stageSQLJSAssets(destDir: string): Promise<boolean> {
	const entry = tryResolvePackageSpecifier(import.meta.url, "sql.js-httpvfs", "dist/index.js")

	if (!entry) {
		console.warn("[host-assets] sql.js-httpvfs is not resolvable — its runtime files were not staged")

		return false
	}

	const distDir = dirname(entry)
	await makeDirectories(destDir)

	for (const file of SQLJS_RUNTIME_FILES) {
		const source = resolvePath(distDir, file)

		if (!(await pathExists(source))) {
			console.warn(`[host-assets] sql.js-httpvfs: ${file} is missing from its dist/`)

			return false
		}

		await syncArtifact(source, resolvePath(destDir, file))
	}

	return true
}
```

Compare with `docs/plugins/demo-assets/artifacts.ts`'s `syncArtifact` and `stageSQLJSHTTPVFS` before deleting them: carry over any behaviour above omits (the size-identical skip and the per-file warning are the two the docstrings name). Then in `artifacts.ts` delete both functions; `stageMapLibreWorker` and `stagePairIndexes` stay, and if they called `syncArtifact`, they import it from `@mailwoman/resolver-wof-wasm/host-assets`. In `plugin.ts` replace `stageSQLJSHTTPVFS(sqljsDir)` with `stageSQLJSAssets(sqljsDir)` imported from the same subpath. Add `"sql.js-httpvfs": "^0.8.12"` to `packages/resolver-wof-wasm/package.json` `dependencies`; if `docs/package.json` still declares it after this task, `knip` in Task 8 says whether docs still needs it.

- [ ] **Step 4: Exports and the moved tests**

Add to `packages/resolver-wof-wasm/package.json` `exports`, in the shape of `"./lookup"`:

```json
"./httpvfs/resolver": { "node": "./lib/httpvfs/resolver.ts", "default": "./out/httpvfs/resolver.js", "types": "./out/httpvfs/resolver.d.ts" },
"./httpvfs/street":   { "node": "./lib/httpvfs/street.ts",   "default": "./out/httpvfs/street.js",   "types": "./out/httpvfs/street.d.ts" },
"./httpvfs/poi":      { "node": "./lib/httpvfs/poi.ts",      "default": "./out/httpvfs/poi.js",      "types": "./out/httpvfs/poi.d.ts" },
"./httpvfs/rows":     { "node": "./lib/httpvfs/rows.ts",     "default": "./out/httpvfs/rows.js",     "types": "./out/httpvfs/rows.d.ts" },
"./host-assets":      { "node": "./lib/host-assets.ts",      "default": "./out/host-assets.js",      "types": "./out/host-assets.d.ts" }
```

```bash
mkdir -p packages/resolver-wof-wasm/test/unit/httpvfs
git mv docs/test/unit/src/shared/httpvfs-resolver.test.ts packages/resolver-wof-wasm/test/unit/httpvfs/resolver.test.ts
git mv docs/test/unit/src/shared/candidate-parity.test.ts packages/resolver-wof-wasm/test/unit/httpvfs/candidate-parity.test.ts
git mv docs/test/unit/src/shared/httpvfs-street.test.ts   packages/resolver-wof-wasm/test/unit/httpvfs/street.test.ts
git mv docs/test/unit/src/shared/stub-worker.ts            packages/resolver-wof-wasm/test/unit/httpvfs/stub-worker.ts
sed -i 's#@mailwoman/docs/shared/httpvfs-resolver#@mailwoman/resolver-wof-wasm/httpvfs/resolver#; s#@mailwoman/docs/shared/httpvfs-street#@mailwoman/resolver-wof-wasm/httpvfs/street#; s#@mailwoman/docs/shared/demo-helpers#@mailwoman/resolver-wof-wasm/httpvfs/street#' packages/resolver-wof-wasm/test/unit/httpvfs/*.test.ts
```

The third substitution is right only for `street.test.ts`, whose one `demo-helpers` import is `resolveStreet`; check the other two files import nothing from `demo-helpers` (`grep -n demo-helpers packages/resolver-wof-wasm/test/unit/httpvfs/*.ts` prints nothing). The `candidate-parity` test opens a SQLite fixture through `@mailwoman/sqlite/client` and `dataRootPath`; it stays a unit test under this package's `test/unit` only if the fast leg already ran it from docs (it did: `docs/test/unit/**` is in the fast include) — keep it there.

- [ ] **Step 5: The docs importers**

```bash
grep -rn "#shared/httpvfs-resolver\|#shared/httpvfs-street\|#shared/poi-httpvfs\|#shared/sqljs-rows\|resolveStreet\|StreetResolution" docs/src --include='*.ts' --include='*.tsx'
```

Each hit imports the wasm subpath instead. The known ones: `demo-loader.ts` (`loadHTTPVFSDatabase`, `WOFCandidateTableLookup`), `_map-helpers.ts` (`loadHTTPVFSDatabase`, `makeHTTPVFSPolygonLookup`), `_runtime.ts` (`HTTPVFSAddressPointLookup`, `HTTPVFSInterpolator`, `resolveStreet`, `StreetResolution`), `index.tsx`, `POIExplorer.tsx` (now passes `poiLayerURL()` and `adminGazetteerURL()` from `#shared/resources` into the two parameterized functions). In `docs/package.json`, `imports["#shared/*"]` keeps resolving the files that remain.

- [ ] **Step 6: Rows, compile, tests, docs build**

Add to `bundle-graph.ts`: `browserRow("@mailwoman/resolver-wof-wasm/httpvfs/resolver")`, `browserRow("@mailwoman/resolver-wof-wasm/httpvfs/street")`, `browserRow("@mailwoman/resolver-wof-wasm/httpvfs/poi")`. `host-assets` is Node-side and gets no row.

```bash
yarn install
yarn compile
yarn oxlint packages/resolver-wof-wasm docs/src docs/plugins
yarn mwops health bundle-graph
yarn mwops health manifest-targets
yarn vitest --run --config vitest.fast.config.ts packages/resolver-wof-wasm/test/unit docs/test/unit
yarn health:architecture
cd docs && yarn build > /tmp/docs-build.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build.log; tail -3 /tmp/docs-build.log; cd -
```

Expected: all pass; `health:architecture` (dependency-cruiser) reports no cycle from `resolver-wof-wasm → spatial`; the docs build exits 0 and its log carries `[host-assets]`-free staging output (`sql.js-httpvfs index.js: synced` lines come from `syncArtifact`'s caller if it logs; add a one-line log per staged file in `stageSQLJSAssets` if the docs build log no longer shows staging and you want it visible).

- [ ] **Step 7: Commit**

```bash
git add packages/resolver-wof-wasm docs packages/repo-health yarn.lock
git commit -m "refactor(resolver-wof-wasm): the httpvfs readers, resolveStreet, their tests and the sql.js host staging live with the browser resolver"
```

---

### Task 3: `mailwoman/browser-runtime`

**Files:**

- Create: `packages/mailwoman/lib/browser-runtime/types.ts`, `resources.ts`, `manifest.ts`, `classify.ts`, `load-assets.ts`, `index.ts`
- Move tests: `docs/test/unit/src/shared/demo-helpers.test.ts` → `packages/mailwoman/test/unit/browser-runtime/classify.test.ts`; `manifest-wire-keys.test.ts` → `…/manifest.test.ts`; `pair-index-url.test.ts` → `…/resources.test.ts`
- Delete after the move: `docs/src/shared/resources/index.ts`, `docs/src/shared/demo-helpers.ts`, `docs/src/shared/demo-loader.ts`
- Modify: `packages/mailwoman/package.json` (six exports), `docs/package.json` (dependency `mailwoman`, drop `imports["#shared/resources"]`), the docs consumers, `packages/mailwoman/lib/commands/gazetteer/publish.tsx:89`, `packages/mailwoman/lib/gazetteer-pipeline/index.ts:500`, `packages/mailwoman/lib/release-tools/publish-hf.ts:286`, `packages/mailwoman/lib/data/bundles.ts:69`, `packages/mailwoman/lib/eval-harness/demo-cascade-smoke.ts:38`, `packages/repo-health/lib/checks/bundle-graph.ts`

**Interfaces:**

- Produces:
  - `mailwoman/browser-runtime/types`: `FSTProvenanceLike`, `FSTMatcherLike`, `MailwomanClassifierLike`, `TraceChannelLike`, `TracePieceLike`, `TraceTokenLike`, `TraceRepairLike`, `ParseTraceLike` (moved verbatim from docs `resources`), and `AssetLoadProgress`.
  - `mailwoman/browser-runtime/resources`: `assetURL`, `releasesManifestURL`, `sqljsBaseURL`, `streetExtractURL`, `adminGazetteerURL`, `poiLayerURL`, `regionToStateSlug`, `neuralClassifierLoadURLs`, `pairIndexBaseURL`, `pairIndexURLs`, `loadFSTGazetteer`, `loadStreetMorphologyFST`, and the pins `NATIONAL_STREET_SLUGS`, `NATIONAL_STREET_EXTRACT_VERSION`, `NATIONAL_STREET_FALLBACK_SLUG`, `ADMIN_GAZETTEER_VERSION`, `POI_LAYER_VERSION`, `HOSTED_STREET_SLUGS`, `PAIR_INDEX_COUNTRIES`, `PAIR_INDEX_VERSION`.
  - `mailwoman/browser-runtime/manifest`: `ReleaseInfo`, `ReleasesManifest`, `WireReleaseEntry`, `normalizeReleasesManifest`, `fetchReleasesManifest`.
  - `mailwoman/browser-runtime/classify`: `runClassifyStage`, `ClassifyStageDeps`, `ClassifyStageHooks`, `ClassifyStageResult`, `SelectPairIndex`, `resolveDualRoles`, `projectCascadeHits`, `parseStageLabelsFor`, `pairCountryForInput`, `createCalibrator`, `Calibrator`, `DEFAULT_LOCALE`, `DEFAULT_ADDRESS`, `EXAMPLE_ADDRESSES`, `ParsedNode`, `TreeNode`, `FlatNode`.
  - `mailwoman/browser-runtime/load-assets`: `loadReleaseAssets(release: ReleaseInfo, progress: AssetLoadProgress, options: { gazetteer?: { sqljsBaseURL: string } }): Promise<ReleaseAssets>` and `ReleaseAssets` (the former `DocsDemoAssets`, its `wofLookup` field `null` when `gazetteer` is not passed).
  - `mailwoman/browser-runtime` (index): re-exports nothing; it is the subpath a bundler resolves for the row and exports `loadReleaseAssets` and `fetchReleasesManifest` directly by importing them, so a host has one entry.

- [ ] **Step 1: Move the three modules into the split**

```bash
mkdir -p packages/mailwoman/lib/browser-runtime
git mv docs/src/shared/resources/index.ts packages/mailwoman/lib/browser-runtime/resources.ts
git mv docs/src/shared/demo-helpers.ts     packages/mailwoman/lib/browser-runtime/classify.ts
git mv docs/src/shared/demo-loader.ts      packages/mailwoman/lib/browser-runtime/load-assets.ts
```

Then split by moving text within the package, not by retyping:

1. From `resources.ts`, move the `…Like` interfaces (`FSTProvenanceLike` through `ParseTraceLike`, and the `DualRole`/`MailwomanLookupLike` re-export line, which is deleted because consumers import `@mailwoman/resolver-wof-wasm/browser-cascade` directly) into a new `types.ts`. `resources.ts` keeps the URL functions, pins and loaders; it imports the `Like` types it references from `#browser-runtime/types`.
2. From `classify.ts`, move `ReleaseInfo`, `ReleasesManifest`, `WireReleaseEntry`, `normalizeReleasesManifest`, `fetchReleasesManifest` into a new `manifest.ts`; `manifest.ts` imports `releasesManifestURL` from `#browser-runtime/resources`. `resolveStreet` and `StreetResolution` already left in Task 2. What remains in `classify.ts` is the list in the Interfaces block; its `ParseResult`/`ResolvedPlaceView` imports come from `@mailwoman/core/pipeline/client-result` (never `@mailwoman/react`), and `runCascade` from `@mailwoman/resolver-wof-wasm/browser-cascade`.
3. In `load-assets.ts`, rename `DocsDemoAssets` → `ReleaseAssets` and `loadDemoAssets` → `loadReleaseAssets`; replace the `ctx: DemoAssetsLoadContext` parameter type with `progress: AssetLoadProgress`, defined in `types.ts` from the fields the function uses (`setProgress`, `setStepLabels`, `setStepIndex`, `setBackend`, `signal`, `forceWASM`; confirm against `packages/react/lib/runtime/useDemoRuntime.ts`'s `DemoAssetsLoadContext` so react's context satisfies it structurally); replace the `sqljsBaseURL: string` parameter with `options: { gazetteer?: { sqljsBaseURL: string } }` and wrap the WOF branch (`loadHTTPVFSDatabase` … `WOFCandidateTableLookup`) in `if (options.gazetteer)`, leaving `wofLookup: null` and no "Loading WOF database" step label otherwise. Its httpvfs import is `@mailwoman/resolver-wof-wasm/httpvfs/resolver`; its `#shared/*` imports become `#browser-runtime/*`.

Write `index.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The browser runtime: what a host needs to load one published release into a working geocoder in a browser, from
 *   the public data origin. The Node counterpart is `createRuntimePipeline`; this composes the same packages for the
 *   client, and it is the one module here that a bundler must be able to build under the `browser` condition.
 */

export { fetchReleasesManifest } from "#browser-runtime/manifest"
export { loadReleaseAssets } from "#browser-runtime/load-assets"
```

Rewrite each moved file's header for its new home; a sentence about the docs site, `/demo`, or "docs-side" goes.

- [ ] **Step 2: Exports and the package's own references**

Add to `packages/mailwoman/package.json` `exports`, in the shape of `"./gazetteer-pipeline"`, entries for `./browser-runtime`, `./browser-runtime/types`, `./browser-runtime/resources`, `./browser-runtime/manifest`, `./browser-runtime/classify`, `./browser-runtime/load-assets`. Update the four in-package mentions:

- `packages/mailwoman/lib/commands/gazetteer/publish.tsx:89`: the string becomes `` `demo: ADMIN_GAZETTEER_VERSION → ${version} (commit packages/mailwoman/lib/browser-runtime/resources.ts)` `` (and "demo:" becomes "browser runtime:" — it is no longer the docs demo's pin).
- `packages/mailwoman/lib/gazetteer-pipeline/index.ts:500`: same path.
- `packages/mailwoman/lib/release-tools/publish-hf.ts:286` and `packages/mailwoman/lib/data/bundles.ts:69`: the fetcher's home is `packages/mailwoman/lib/browser-runtime/resources.ts`.
- `packages/mailwoman/lib/eval-harness/demo-cascade-smoke.ts:38`: this paragraph is history that no longer describes a file that exists; replace the sentence naming `docs/src/shared/demo-helpers.ts` with one that says `runCascade` comes from `@mailwoman/resolver-wof-wasm/browser-cascade` and `flattenTreeNodes` from `@mailwoman/core/decoder`, and drop the rest of the incident narration.

- [ ] **Step 3: The moved tests**

```bash
mkdir -p packages/mailwoman/test/unit/browser-runtime
git mv docs/test/unit/src/shared/demo-helpers.test.ts       packages/mailwoman/test/unit/browser-runtime/classify.test.ts
git mv docs/test/unit/src/shared/manifest-wire-keys.test.ts packages/mailwoman/test/unit/browser-runtime/manifest.test.ts
git mv docs/test/unit/src/shared/pair-index-url.test.ts     packages/mailwoman/test/unit/browser-runtime/resources.test.ts
sed -i 's#@mailwoman/docs/shared/demo-helpers#mailwoman/browser-runtime/classify#; s#@mailwoman/docs/shared/resources#mailwoman/browser-runtime/resources#' packages/mailwoman/test/unit/browser-runtime/*.test.ts
```

`manifest.test.ts` imports `normalizeReleasesManifest` and `WireReleaseEntry`, which now live in `manifest`, so its specifier is `mailwoman/browser-runtime/manifest`, not `classify`; `classify.test.ts` imports `MailwomanLookupLike` from `@mailwoman/resolver-wof-wasm/browser-cascade`. `rmdir docs/test/unit/src/shared` once empty.

- [ ] **Step 4: Docs consumes the package**

`docs/package.json`: add `"mailwoman": "workspace:*"` to `dependencies`; delete `imports["#shared/resources"]`. Then rewrite the docs importers with these substitutions (a file that took a name that moved between modules follows the Interfaces block above):

```bash
grep -rln "#shared/resources\|#shared/demo-helpers\|#shared/demo-loader\|shared/resources/index\|shared/demo-helpers\|shared/demo-loader" docs/src docs/test --include='*.ts' --include='*.tsx'
```

For each: `#shared/resources` → `mailwoman/browser-runtime/resources` for URLs, pins and loaders, or `mailwoman/browser-runtime/types` for a `…Like` type; `#shared/demo-helpers` → `mailwoman/browser-runtime/classify` or `…/manifest`; `#shared/demo-loader` → `mailwoman/browser-runtime/load-assets`, with `loadDemoAssets(release, ctx, sqljsBaseURL)` becoming `loadReleaseAssets(release, ctx, { gazetteer: { sqljsBaseURL } })` in `_runtime.ts` and in `DemoEmbed.tsx` (the docs explainers `PipelineExplorer` and `GuidedTour` resolve through `wofLookup`, so the docs embed keeps the gazetteer). `docs/src/pages/trace.tsx` and `POIExplorer.tsx` take `sqljsBaseURL` from the new resources subpath.

- [ ] **Step 5: Row, compile, tests, docs build**

Add `browserRow("mailwoman/browser-runtime", { allowedDynamicImports: NEURAL_DYNAMIC_IMPORTS })` to `bundle-graph.ts`; the loader's `import("@mailwoman/neural/web-loader")` stays external under the default policy, and nothing on its static graph may reach Node.

```bash
yarn install
yarn compile
yarn oxlint packages/mailwoman/lib/browser-runtime docs/src docs/test
yarn mwops health bundle-graph
yarn mwops health manifest-targets
yarn mwops health exports
yarn vitest --run --config vitest.fast.config.ts packages/mailwoman/test/unit/browser-runtime docs/test/unit
yarn health:architecture
cd docs && yarn typecheck && yarn build > /tmp/docs-build.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build.log; tail -3 /tmp/docs-build.log; cd -
```

Expected: every command passes. If the `mailwoman/browser-runtime` row reports a static Node edge, the file it names imported a Node-only sibling through the package's `#` map; the fix is a narrower import from that sibling's browser-safe subpath, never a stub.

- [ ] **Step 6: Commit**

```bash
git add packages/mailwoman docs packages/repo-health yarn.lock
git commit -m "feat(mailwoman): browser-runtime — the release manifest, asset URLs and pins, the classify stage and the release loader have one home"
```

---

### Task 4: The two presentation helpers move to `@mailwoman/react/common`

**Files:**

- Move: `docs/src/shared/confidence-tiers.ts` → `packages/react/lib/common/confidence-tiers.ts`; `docs/src/shared/text-tokens.ts` → `packages/react/lib/common/text-tokens.ts`
- Modify: `packages/react/lib/pipeline/ConfidenceCell.tsx` (delete its private `HIGH_CONFIDENCE_MIN`/tier function; import the shared one), `packages/react/package.json` (two exports), the docs consumers

- [ ] **Step 1: Move, export, dedupe**

```bash
git mv docs/src/shared/confidence-tiers.ts packages/react/lib/common/confidence-tiers.ts
git mv docs/src/shared/text-tokens.ts      packages/react/lib/common/text-tokens.ts
```

Add exports `./common/confidence-tiers` and `./common/text-tokens` in the shape of `./common/KindBadge`. In `ConfidenceCell.tsx`, delete the local `HIGH_CONFIDENCE_MIN`, `MID…` and the private tier function (lines 13-30 region; read them first) and `import { confidenceTierOrMid } from "#common/confidence-tiers"` (or `confidenceTier`, whichever the cell's null handling matches). Rewrite the docs consumers:

```bash
grep -rln "#shared/confidence-tiers\|#shared/text-tokens" docs/src --include='*.tsx' --include='*.ts'
```

`SpanHighlight`, `TreeView`, `ClassifierOverlay`, `SubwordExplorer` → `@mailwoman/react/common/confidence-tiers`; `SubwordExplorer`, `BIOHighlight` → `@mailwoman/react/common/text-tokens`.

- [ ] **Step 2: Verify and commit**

```bash
yarn compile
yarn oxlint packages/react/lib/common docs/src/components
yarn workspace @mailwoman/react test:browser
yarn mwops health private-name-shadows-export
cd docs && yarn build > /tmp/docs-build.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build.log; tail -2 /tmp/docs-build.log; cd -
git add packages/react docs
git commit -m "refactor(react): confidence tiers and word tokens are common helpers, and ConfidenceCell uses the shared tiers"
```

Expected: the shadow check no longer lists a private confidence threshold in react; the docs build exits 0.

---

### Task 5: `docs/src/shared` holds only what the second plan moves

- [ ] **Step 1: Confirm the residue**

```bash
ls docs/src/shared
grep -rn "docs/src/shared" packages --include='*.ts' --include='*.tsx' | grep -v "/out/"
```

Expected: `maplibre-worker.ts`, `maplibre-worker-url.ts`, `register-range-sw.ts` and nothing else; the second command prints only the two twin comments in `resolver-wof-sqlite` (`candidate-lookup.ts:8`, `primary-preference.ts:8`) and `spatial/polyline.ts:11`, which now name the wasm subpath:

```bash
sed -i 's#docs/src/shared/httpvfs-resolver.ts#packages/resolver-wof-wasm/lib/httpvfs/resolver.ts#' packages/resolver-wof-sqlite/lib/candidate-lookup.ts packages/resolver-wof-sqlite/lib/primary-preference.ts
sed -i 's#docs/src/shared/httpvfs-street.ts#packages/resolver-wof-wasm/lib/httpvfs/street.ts#' packages/spatial/lib/polyline.ts
sed -i 's#docs/src/shared/#packages/resolver-wof-wasm/lib/httpvfs/#' packages/resolver-wof-wasm/lib/browser-cascade.ts
```

Read each edited sentence afterwards; one that only makes sense as a "this used to live in docs" story is deleted rather than repointed.

- [ ] **Step 2: Commit**

```bash
git add packages/resolver-wof-sqlite packages/spatial packages/resolver-wof-wasm
git commit -m "docs(comments): the browser twins are named by their package path"
```

---

### Task 6: Parity on the docs page

- [ ] **Step 1: Serve the build and run the two specs**

```bash
cd docs
yarn build > /tmp/docs-build.log 2>&1; echo "EXIT=$?" >> /tmp/docs-build.log; grep -n "^EXIT=\|Can't resolve" /tmp/docs-build.log
BROWSER=none yarn docusaurus serve --no-open --host 0.0.0.0 --port 7770 > /tmp/docs-serve.log 2>&1 &
until curl -sf -o /dev/null http://localhost:7770/; do sleep 1; done
yarn test:e2e --project=chromium test/browser/100-demo-cold-load.spec.ts test/browser/200-demo-resolve.spec.ts 2>&1 | tail -12
kill %1
cd -
```

Expected: `EXIT=0`; 7 of 7 specs pass. `docusaurus serve` opens a browser through the `BROWSER` variable, which the lab sets to `none`; `--no-open` is the flag that stops it.

- [ ] **Step 2: The lockstep test still holds**

```bash
yarn vitest --run --config vitest.fast.config.ts packages/resolver-wof-wasm/test/unit/httpvfs/candidate-parity.test.ts
```

Expected: PASS. This is the browser-versus-Node candidate ranking parity; it moved packages and must still compare the same two implementations.

---

### Task 7: Preflight and PR

- [ ] **Step 1: Preflight**

```bash
yarn compile
yarn health > /tmp/health.log 2>&1; echo "EXIT=$?" >> /tmp/health.log; grep -n "✗\|error:\|EXIT=" /tmp/health.log | head
yarn typecheck:tests
yarn ci:test:fast > /tmp/fast.log 2>&1; echo "EXIT=$?" >> /tmp/fast.log; grep -E "Tests |Test Files|EXIT=" /tmp/fast.log
yarn workspace @mailwoman/react test:browser
```

`health:knip` decides which docs dependencies are now unused; remove each one it names from `docs/package.json` in this task (the spec's list is a prediction; knip is the measurement), run `yarn install`, and rebuild the docs once more. `health:debt` failing only on counters `main` already fails is not this branch's.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/earth-runtime-homes
gh pr create --title "Earth runtime, part 1: the browser runtime's package homes" --body-file - <<'EOF'
Implements the move map of docs/superpowers/specs/2026-09-06-earth-app-design.md by docs/superpowers/plans/2026-09-07-earth-runtime-homes.md. The docs site still serves the geocoder page; it now consumes packages for everything under the former docs/src/shared.

- @mailwoman/core/pipeline/client-result: the parse result is one contract (react's ParseResult and docs' DemoResult were the same shape written twice)
- @mailwoman/resolver-wof-wasm/httpvfs/{resolver,street,poi,rows} + host-assets: the sql.js-httpvfs readers, resolveStreet, their four tests, the host staging
- mailwoman/browser-runtime/{types,resources,manifest,classify,load-assets}: the release manifest, asset URLs and version pins, the classify stage, the release loader (gazetteer optional); `mailwoman gazetteer publish` now names a file in its own package
- @mailwoman/react/common/{confidence-tiers,text-tokens}; ConfidenceCell drops its private copy
- bundle-graph rows for every new browser subpath

Placements that differ from the spec's table, and why: the runtime assembly stays application code (react must not carry the runtime graph); the loader lives in mailwoman, which already depends on neural and the browser resolver; the sql.js staging stays in docs because PipelineExplorer and GuidedTour resolve against the gazetteer.

Verification: docs build EXIT=0 under rspack; 100-demo-cold-load and 200-demo-resolve 7/7; the moved tests pass in their new packages; bundle-graph, manifest-targets, exports, architecture pass.

https://claude.ai/code/session_01ADYjzV88cHb94MRW4Dn1Aq
EOF
```

---

### Task 8: Spec receipt

- [ ] **Step 1: Amend the move map in the spec**

In `docs/superpowers/specs/2026-09-06-earth-app-design.md`, "The move map": the rows for `httpvfs-resolver`, `candidate-resolver-backend`, `httpvfs-street`, `poi-httpvfs`, `demo-loader`, `demo-helpers`, `confidence-tiers`, `resources/index.ts` and `_runtime.ts` take the destinations this plan's move map names, with three sentences after the table:

> The runtime assembly (`_runtime.ts`) stays application code: `@mailwoman/react` keeps its runtime hook free of the ONNX, httpvfs and maplibre graph by design, and the assembly imports all three. The loader lives in `mailwoman`, the one package that already depends on `neural` and `resolver-wof-wasm`, so the version pins `mailwoman gazetteer publish` bumps are package-local. The sql.js staging stays in docs: `PipelineExplorer` and `GuidedTour` resolve against the gazetteer, so the docs embed keeps the gazetteer half of the loader and the staged worker.

And in "Docs after the move", replace the dependency list with: "`docs/package.json` loses every dependency `knip` reports unused once the page and its runtime leave; the list is measured at that point, not predicted here."

```bash
git add docs/superpowers/specs/2026-09-06-earth-app-design.md
git commit -m "docs(specs): the Earth move map records where the runtime landed and why"
git push
```
