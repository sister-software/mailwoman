# AGENTS.md — `@mailwoman/core`

Read the repository-root `AGENTS.md` first. This file governs core interfaces and every workspace that
uses them.

## HTTP requests

HTTP clients extend or instantiate `APIClient` from `@mailwoman/core/api`. It provides pacing after
cache lookup, bounded retry when `retry` is configured, response caching, and `ResourceError` mapping.
Callers branch on `error.status` or `isTransientResourceError(error)` instead of matching error text.
Inject a clock and use `@mailwoman/core/api/test-clocks` in timing tests.

`packages/filer/lib/sdk/sec-client.ts` is the primary example. `packages/bdc/lib/sdk/client.ts` shows
binary responses and per-request `cache: false`.

`requestsPerMinute` computes a cooldown of `60000 / N` after the previous dispatch. It does not enforce
a full-minute window: a measured configuration of 10 dispatched 100 requests per minute. Set
`minRequestIntervalMs` to `60000 / N` when the host requires that interval.

Use `APIClient` for repeated API requests with small responses. Keep direct streaming transfers for
multi-gigabyte archives, including `packages/osm/lib/sdk/fetch.ts` and
`packages/tiger/lib/sdk/download.ts`; buffering or caching those responses would change their memory and
disk behavior.

## Filesystem and paths

Executable repository code accesses the filesystem through `@mailwoman/core/fs`. Only core imports
`node:fs`; oxlint reports imports elsewhere and names the core module to use.

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

Static and dynamic sibling imports use the workspace `#` imports map. Do not use a relative dynamic
import or `import.meta.resolve`. Importing `package.json` as a JSON module makes TypeScript copy it into
`out/` and changes the compiled package scope. Read it with
`readLocalJSONFile(resolvePackagePath(name, "package.json"))`.

`packages/repo-health/lib/checks/node-modules-reacharound.ts` reports constructed `node_modules` paths.
Normal path composition under a caller-supplied root, scratch directory, or user output path remains
valid. A clean-install probe may inspect a foreign install layout because resolving from the monorepo
would invalidate the probe.

`packages/core/lib/utils/repo.ts` counts upward from `import.meta.url`. The source `lib/` tree and the
compiled `out/` tree have equal depth, so the same constants serve both. Preserve that equal-depth
layout; the removed compiled-tree branch overshot `out/` in production.

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
- `@mailwoman/core/utils/sealed-db`: `swapDatabaseIntoPlace`, `sealDatabase`, and
  `openBuiltDatabase`.
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
or dependency graph caused the local implementation. Fix the shared interface when appropriate; keep a
documented local implementation when the dependency cost is larger than the duplication.

## Core tests and Vite

When one core test imports both `@mailwoman/core` and a core subpath, Vite can interleave the barrel and
subpath graphs before the barrel finishes binding its exports. Base classes can then evaluate as
`undefined`. A side-effect `import "@mailwoman/core"` at the start of the affected test forces the barrel
to initialize first. This is a structural import-graph issue tracked on #481; top-level await is not its
cause.
