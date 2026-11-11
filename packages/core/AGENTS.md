# AGENTS.md — `@mailwoman/core`

Read the repository-root `AGENTS.md` first. This file governs core interfaces and every workspace that
uses them.

## HTTP requests

HTTP clients extend or instantiate `APIClient` from `@mailwoman/core/api`. It provides pacing after
cache lookup, bounded retry when `retry` is configured, response caching, and `ResourceError` mapping.
Callers branch on `error.status` or `isTransientResourceError(error)` instead of matching error text.
Inject a clock and use `@mailwoman/core/api/test-clocks` in timing tests.

`packages/filer/sdk/sec-client.ts` is the primary example. `packages/bdc/sdk/client.ts` shows
binary responses and per-request `cache: false`.

`requestsPerMinute` computes a cooldown of `60000 / N` after the previous dispatch. It does not enforce
a full-minute window: a measured configuration of 10 dispatched 100 requests per minute. Set
`minRequestIntervalMs` to `60000 / N` when the host requires that interval.

Use `APIClient` for repeated API requests with small responses. Keep direct streaming transfers for
multi-gigabyte archives, including `packages/osm/sdk/fetch.ts` and
`packages/tiger/sdk/download.ts`; buffering or caching those responses would change their memory and
disk behavior.

`TypeError: fetch failed` names no layer. Read `error.cause.code` first and confirm with a raw
`node:net` socket. A socket that connects while HTTPS fails is TLS, and the first suspect is the
certificate: a wildcard certificate covers one label below the domain and leaves the apex uncovered,
so try `www.` and `api.`.
`ECONNREFUSED` is a host with no listener, a timeout with no response is a filtered port, and
`ENOTFOUND` is name resolution. Before writing that a host is unreachable, print the cause, probe the
socket, and resolve the name.

## Filesystem and paths

Executable repository code accesses the filesystem through `@mailwoman/core/fs`. Only core imports
`node:fs`. Oxlint reports an import of it elsewhere, and its message identifies the core module to use.

- `/readers` and `/writers` return promises.
- `/streams` returns streams immediately and performs work as consumers pull.
- `/temporary` owns scratch directories.
- `readFileRange` and `open` cover file-descriptor work retained across calls.

Every helper accepts `PathBuilderLike`. Choose the helper whose name matches the required failure
behavior: `statPath` raises on a missing path while `tryStat` returns `null`; `removePath` raises while
`removePathIfPresent` accepts an absent target; `makeDirectories` is recursive and idempotent while
`makeDirectoryExclusive` raises `EEXIST`. The two repository locks depend on exclusive directory
creation as an atomic test-and-set.

Writers create their parent directory. `copyFileTo` and `createSymbolicLink` clear their destination
because copying onto a symlink writes through the link. `pathExists` deliberately narrows
`existsSync`: failure to read a parent directory raises an error. A successful lookup reports whether
the path is absent.

Use `path-ts` for path composition. Use `import.meta.dirname` and `import.meta.filename` for the current
module. Convert another `file:` URL through `@mailwoman/core/module/file-url`.

The tokenizer in `@mailwoman/neural` is the one documented exception. It dynamically imports
`node:fs/promises` with `webpackIgnore` so the browser bundle does not acquire core's Node graph.
`browser-slo.test.ts` detects a static replacement that makes esbuild resolve `fs`.

## Data, package, and repository roots

Use `dataRootPath` from `@mailwoman/core/data-root` for data artifacts. Use `configRootPath` for
configuration artifacts. Shipped code and documentation refer to `$MAILWOMAN_DATA_ROOT`; they do not
contain a lab-specific path.

A database under the data root's `db/` group is located by the package that owns it, through that
package's `paths` export: `wofDatabasePath("admin-global-priority.db")` from
`@mailwoman/resolver-wof-sqlite/paths`, `banDatabasePath` from `@mailwoman/ban/paths`, and the same
pattern in `soil`, `flood`, `coastal`, `zoning`, `osm` and `timezone-lookup`. Each constant reads the
data root when a path is requested. The matching `…DatabaseRoot(dataRoot)` function takes an explicit
root. Core keeps only `databaseRootPath`, for a package that cannot depend on the owner.

Never construct another package's location through a `node_modules` segment. Use one of these
interfaces:

- `resolveModulePath("pkg/file")` or `resolvePackageDirectory("pkg")` for installed modules.
- A public `exports` subpath when the file is part of the package interface.
- `resolvePackagePath("package", ...)` for a package's own data, script, or fixture.
- `repoRootPath(...)` for a repository file.
- `dataRootPath(...)` for a data-root artifact.

Use `createRequire(import.meta.url).resolve` only where the loader cannot provide `import.meta`, as
documented in `docs/plugins/demo-assets/resolve.ts`.

Docusaurus evaluates every `docs/plugins/` module and everything it imports through jiti's CommonJS
transform. That transform rewrites `import.meta.url` but refuses a bare `import.meta` (including
`import.meta.resolve`), an `import(…, { with: { type: "json" } })`, and a `using` or `await using`
declaration. `tsc`, oxlint and vitest all pass over them, and the error points at a file's `:0:0`
rather than at the construct. A helper a docs plugin may import lives in `@mailwoman/core/module/resolve-from`
and never in `module/resolvers`. Before pushing a change to a plugin's import graph, load the touched
files through `@docusaurus/utils/node_modules/jiti` with a short `.cjs` probe or run
`yarn workspace @mailwoman/docs build`.

Static and dynamic sibling imports use the workspace `#` imports map. Do not use a relative dynamic
import. A literal `#` alias may be resolved with `import.meta.resolve` when a child process needs the
module's file path. Convert its `file:` URL with `fileURLToPath`.
A JSON-module import of `package.json` makes TypeScript copy it into
`out/` and changes the compiled package scope. Read it with
`readLocalJSONFile(resolvePackagePath(name, "package.json"))`.

`lib/repo-health/checks/node-modules-reacharound.ts` reports constructed `node_modules` paths.
Normal path composition under a caller-supplied root, scratch directory, or user output path remains
valid. A clean-install probe may inspect a foreign install layout because resolving from the monorepo
would invalidate the probe.

`repoRootPath` names the checkout `@mailwoman/core` was loaded from, which is another checkout when a
worktree has no install of its own. `@mailwoman/core/module/checkout-locality` compares that checkout with
the entry point's. A repository entry point calls `assertCheckoutLocality(import.meta.dirname)` before it
loads the rest of its graph.

`packages/core/lib/utils/repo.ts` counts upward from `import.meta.url`. The source `lib/` tree and the
compiled `out/` tree have equal depth, so the same constants serve both. Preserve that equal-depth
layout. The removed compiled-tree branch overshot `out/` in production.

## Shared implementations

Check these homes before adding a helper:

- `@mailwoman/core/random`: `mulberry32`, `makeLcg`, and `SeededRandom`. Prefer `mulberry32` for new
  behavior; `makeLcg` retains streams embedded in corpus rows and evaluation splits.
- `@mailwoman/core/stats`: `percentile`, `median`, and `formatPercent`. `percentile` accepts a value in
  `[0, 100]`, not a fraction.
- `@mailwoman/core/hash`: `sha256File`, `sha256Hex`, and `md5File`.
- `@mailwoman/core/utils/time`: `isoDate`, `isoSeconds`, and `isoSecondsUTC`.
- `@mailwoman/core/git`: `gitHead`, `currentBranch`, `dirtyTrackedFiles`, and `trackedFiles`.
- `@mailwoman/core/fs/writers`: `changeMode` and `writePrivateTextFile`.
- `@mailwoman/sqlite/sealed/db`: `swapDatabaseIntoPlace` and `sealDatabase`.
  `@mailwoman/sqlite/sealed` holds `openBuiltClient`, and `@mailwoman/sqlite/sealed/build` holds
  `buildSealedArtifact`.
- `@mailwoman/core/release-config`: the typed `release.config.json` reader.
- `@mailwoman/spatial`: geographic distance, polygon containment, and bounding-box helpers.
- `packages/match/lib/comparators.ts`: string similarity functions.

There is no `@mailwoman/core/utils/jsonl` implementation. Read JSONL with
`Array.fromAsync(JSONSpliterator.fromAsync<T>(path))`.

`mailwoman/prefer-home` reports repeated implementation shapes. The
`private-name-shadows-export` repository check reports a private function whose name matches an exported
function. A justified local implementation uses
`// repo-health-ignore private-name-shadows-export -- <reason>`.

When a shared helper does not fit a caller, determine whether its performance, asynchronous interface,
or dependency graph caused the local implementation. Fix the shared interface when appropriate. Keep a
documented local implementation when the dependency cost is larger than the duplication.

## Platform conditions

A subpath that must run in workerd or a browser declares `workerd` and `browser` export conditions
beside `node` in the owning package rather than moving to a leaf package. A platform-neutral
implementation such as WebCrypto needs no condition. Prove worker safety with an esbuild bundle test
under `--conditions=workerd,worker,browser`, in the shape of
`packages/neural/lib/web/browser-slo.integration.test.ts`. When a name moves, every caller is
repointed in the same change, and no forwarding export stays.

## Import-time effects

An import-time effect is work a module does when it is evaluated: it registers a listener, writes a
global, mutates another module's state, imports CSS, or starts I/O. A value a module computes for its
own constants, such as `new Set(Object.keys(TABLE))`, is no effect, and neither is a write to an object
the module itself declares.

A bundler that reads `sideEffects: false` drops a module whose exports go unused, and with it whatever
the module runs at evaluation. A workspace that declares the field lists each module that runs an
import-time effect, by its source path and its `out/` path. A `*.run.ts` script and `cli/main.ts` are
entry points whose module-scope statements are the program, so they are listed by glob. An `if
(import.meta.main)` block runs only for the entry point and needs no listing. The `side-effects`
repository check reads every declaring workspace's sources and reports a module the declaration
misses.

`/* @__PURE__ */` tells a bundler it may delete a call whose result goes unused. Put it only on a call
whose callee you have read, never on an effect interface. The same check reports an annotated
effect-interface call.
`mwops side-effects` reports the bytes a bare import of each module keeps when every module counts as
effectful. Those bytes show where an annotation would shrink a bundle.

`docs/engineering/reference/effects-register.mdx` lists each module's import-time effects and runtime
effect edges, one page per workspace. Regenerate it with `yarn mwops effects-register` after a change
that adds, removes or moves an effect. The `effects-register` check fails while a page is stale.

## State machines

A lifecycle whose state is stored, such as a ledger column, is declared with `defineStateMachine` from
`@mailwoman/core/state-machine`. Its transition is a pure function from a state and an event to a step:
the next state, the columns written with it, and the effects to run after the write. `applyStep`
writes the step through a carrier's compare-and-set, so a step decided from a state another writer has
since left fails as a conflict. A machine's `events` table holds one event per case its transition
distinguishes, and the effects register prints the machine's transition table from it.
`packages/license-worker/lib/ledger/machines.ts` holds the first three machines.

## Core tests and Vite

When one core test imports both `@mailwoman/core` and a core subpath, Vite can interleave the barrel and
subpath graphs before the barrel finishes binding its exports. Base classes can then evaluate as
`undefined`. A side-effect `import "@mailwoman/core"` at the start of the affected test forces the barrel
to initialize first. This is a structural import-graph issue tracked on #481. Top-level await is not its
cause.
