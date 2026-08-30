# sync-fs-to-async

Rewrites a synchronous `node:fs` call that stands inside an `async` function to the matching asynchronous helper in
`@mailwoman/core/fs/readers` or `@mailwoman/core/fs/writers`, adds the import, and drops the synchronous binding it
orphaned.

## Why only that position

An AST census of this repository counted **1,943 synchronous `node:fs` call sites in 514 files**. The useful number is
not that total — it is the split by whether an `await` is legal where the call stands:

| context         | meaning                                           | sites |
| --------------- | ------------------------------------------------- | ----: |
| `async`         | the nearest enclosing function is already `async` |   961 |
| `sync-fn`       | the nearest enclosing function is not             |   625 |
| `module`        | a top-level statement                             |   221 |
| `sync-callback` | inside a non-async callback                       |   136 |

Only the first is mechanical. Converting a `sync-fn` site changes that function's signature and every caller's;
converting a `module` site moves work to import time. Both are decisions. This codemod rewrites the 961 and leaves the
other 982 exactly as they are — which is also why running it is safe on a repository that has partly migrated already:
it matches the synchronous name, so a rewritten call is not a candidate a second time.

## The mapping table

Every mapping is either equal to the builtin or a strict **superset** of it — it succeeds where the builtin threw, and
fails nowhere the builtin succeeded. The supersets are the two ceremonies the helpers exist for: the file writers
create the parent directory, and `copyFileTo` / `createSymbolicLink` clear the destination first.

| builtin                                                          | shape               | helper                               |
| ---------------------------------------------------------------- | ------------------- | ------------------------------------ |
| `existsSync(p)`                                                  |                     | `pathExists`                         |
| `statSync(p)` / `lstatSync(p)` / `realpathSync(p)`               | one argument        | `statPath` / `statLink` / `realPath` |
| `readFileSync(p, "utf8")`                                        |                     | `readLocalTextFile`                  |
| `readFileSync(p)`                                                | one argument        | `readLocalBuffer`                    |
| `readdirSync(p)`                                                 |                     | `readDirectory`                      |
| `readdirSync(p, { withFileTypes: true })`                        |                     | `readDirectoryEntries`               |
| `writeFileSync(p, c)`                                            | `c` certainly text  | `writeLocalTextFile`                 |
| `writeFileSync(p, c)`                                            | `c` certainly bytes | `writeLocalBuffer`                   |
| `writeFileSync(p, c)`                                            | neither             | `writeLocalFile`                     |
| `appendFileSync(p, c)`                                           |                     | `appendLocalTextFile`                |
| `mkdirSync(p, { recursive: true })`                              | value unused        | `makeDirectories`                    |
| `mkdirSync(p)`                                                   | value unused        | `makeDirectoryExclusive`             |
| `rmSync(p)` / `rmSync(p, { recursive: true })` / `unlinkSync(p)` |                     | `removePath`                         |
| `rmSync(p, { force: true })` / `{ recursive, force }`            |                     | `removePathIfPresent`                |
| `renameSync(a, b)`                                               |                     | `movePath`                           |
| `copyFileSync(a, b)` / `cpSync(a, b, { recursive: true })`       |                     | `copyFileTo` / `copyPath`            |
| `symlinkSync(t, l)`                                              |                     | `createSymbolicLink`                 |
| `chmodSync(p, m)` / `utimesSync(p, a, m)`                        |                     | `changeMode` / `setTimestamps`       |

Throwing and forgiving are never conflated, because that is the distinction a rename can silently destroy:

- `statSync` becomes `statPath`, which raises ENOENT like the builtin — never `tryStat`, which answers `null`.
- `mkdirSync(p)` without `recursive` becomes `makeDirectoryExclusive`, **not** `makeDirectories`. Bare `mkdir` is an
  atomic test-and-set and is how both of this repository's inter-process locks are held; the idempotent helper would
  let every waiter take the lock at once, and nothing would report it.
- The two removal helpers differ only in which absence they forgive, so the builtin's options decide which one it was.

`existsSync` is the one deliberate **narrowing**. It answers `false` for a path it could not read — EACCES on a parent
directory reports as absence — where `pathExists` throws. A reader that cannot tell "there is none of it" from "I could
not look" is the failure mode this repository has been bitten by, so the narrowing is the point.

`accessSync`, `globSync`, `readlinkSync`, `rmdirSync`, `mkdtempSync` and the file-descriptor calls (`openSync`,
`closeSync`, `readSync`, `writeSync`) have no equal helper and are left alone. `mkdtempSync` in particular wants
`temporaryDirectory` from `@mailwoman/core/fs/temporary` bound with `await using`, which is an ownership change rather
than a rename.

## Three ways a call becomes reachable

1. **The enclosing function is already `async`.** One `await` and a specifier change.
2. **The enclosing function is a callback the test runner awaits** — `it`, `test`, `bench`, `beforeAll`/`beforeEach`/
   `afterAll`/`afterEach`, including the `it.each(rows)(…)` and `test.skipIf(cond)(…)` forms. Marking it `async` costs
   nothing. `describe` is deliberately excluded: vitest COLLECTS synchronously, so an `async` describe body returns a
   promise the collector never waits on and every `it` inside registers after collection has ended.
3. **The enclosing function is file-local, and so is every caller of it.** The codemod makes that function `async`,
   rewrites its return annotation `: T` to `: Promise<T>`, and inserts an `await` at each call site — recursively,
   until the closure is complete.

The cascade is **all-or-nothing**. A cascade that stops halfway leaves an un-awaited promise where a value used to be,
which is a silent wrong answer rather than a compile error in every position. So one unreachable caller refuses the
whole closure, and these are the refusals:

| refusal                               | why                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| the function is exported              | the signature change crosses the package boundary                                   |
| it is called at module scope          | top-level `await` is legal, but it moves work to import time                        |
| it is used as a value, not called     | `paths.map(read)` passes the function; making it async changes what `.map` produces |
| its binding carries a type annotation | `const health: Engine["health"] = …` states a synchronous contract                  |
| a caller is a callback nobody awaits  | `.filter(…)`, `.find(…)`, `.sort(…)` have no asynchronous form                      |

The last two were found by running this codemod over the repository and reading the compiler, not by reasoning:
promoting an annotated binding turned `() => HealthData` into `() => Promise<HealthData>` against a live interface, and
a recursive `out.push(...walk(child))` left un-awaited reported as a missing `[Symbol.iterator]` several frames from
the cause.

## What it edits, and what it refuses to

- A call is a candidate only when its callee is an identifier bound from `@mailwoman/platform/fs`, `node:fs` or `fs` —
  by a static `import`, **or** by the `await import("…")` destructuring the Ink commands use to keep a Node builtin out
  of a bundle. Missing that second form is what left 43 call sites behind on a first pass.
- Parentheses are added only where `await` would bind wrong: a member access, a call callee, a unary operand, a
  template substitution.
- `mkdirSync` whose return value is read is left alone — the builtin answers the first directory it created, and
  neither helper answers the same thing.
- An orphaned static import of named bindings only is removed with its statement. Anything else keeps its statement: a
  default or namespace binding is still live, and `const {} = await import(…)` still evaluates the module.
- Imports are prepended as a block. Placement within the existing import list is the formatter's job.

## The three parameters

All opt-in. Without them the codemod does the mechanical half and nothing else.

| parameter                        | what it unlocks                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topLevelAwait=<path fragments>` | a module-scope call may become a top-level `await` in a file matching one of these. Pass only ENTRIES — `.test.ts`, `/scripts/`, `/dev-tools/`, `.run.ts` — because top-level await in an IMPORTED module makes its evaluation asynchronous, which this repository has already had to undo once for cause (`packages/core/resources/libpostal.ts`, #481). |
| `promote=<names>`                | function names this run is making `async` across the whole repository, so a call to one gets its `await` in every file. Computed as a repo-wide fixpoint by `scratchpad/codemod/promotion-set.ts`, which is where the cross-file question is answered.                                                                                                    |
| `syncFallback=true`              | where the call cannot become asynchronous at all, rewrite to the `Sync`-suffixed helper rather than leaving the builtin. This is the second pass: after everything that could move has moved, what remains still reaches a HELPER, which is what leaves `@mailwoman/platform/fs` to `packages/core/fs/*` alone.                                           |

The promises mirror needs no parameter. `@mailwoman/platform/fs/promises` and
`node:fs/promises` map onto the same helpers by the same rules, and the rewrite
adds no `await` — those names already answer a promise, so the call site's
existing handling is correct as it stands.

## Running it

```bash
yarn dlx codemod@latest jssg run ./scripts/codemod.ts --language typescript -t /path/to/mailwoman --dry-run
yarn dlx codemod@latest jssg run ./scripts/codemod.ts --language tsx        -t /path/to/mailwoman --dry-run
```

Drop `--dry-run` to apply, then run the repository's formatter — this codemod does not order imports.

Point `-t` at a subdirectory rather than the repository root, or the run rewrites this package's own fixtures, which are
the before-and-after it is measured against.

`workflow.yaml` declares the same two steps and validates, but `codemod workflow run` scanned zero files against this
repository at every combination of relative and absolute `base_path` and `js_file` that was tried, where `jssg run` over
the identical target found ten. Until that is understood, `jssg run` is the path that works.

## What it never touches

- `packages/core/fs/*` — the destination. It rewrote the helper BODIES to call themselves on the first run, which
  typecheck accepts and which is an infinite loop at runtime.
- `docs/scripts/{check-docs-structure,list-stale-docs,docs-frontmatter}.ts` — the Docs workflow runs these BEFORE
  `yarn install`, so every module they import must resolve from the checkout alone. A workspace import here resolves on
  a developer machine, passes review, and fails only on CI as `ERR_MODULE_NOT_FOUND`.
  `scripts/preinstall-scripts.test.ts` is the executable half of that exemption; keep the two lists in step.

## Tests

```bash
yarn test
```

Twelve fixtures. The ones worth naming are the ones that caught a real defect while running over this repository:

| fixture                            | asserts                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `positive-async-context`           | every mapping fires, imports are added, the orphaned import goes                                      |
| `positive-awaited-callback`        | an `it`/`test`/`before*` callback is marked `async`, once per callback; `describe` is not             |
| `positive-local-cascade`           | a file-local function and every in-file caller become `async` together                                |
| `positive-deferred-import`         | the `await import(…)` form is rewritten, and a name a sync callback still uses survives the prune     |
| `positive-module-alias`            | `fs.readFileSync(…)` where `fs` is one element of an array pattern destructured from `Promise.all`    |
| `positive-json-collapse`           | `parseJSONStrict<T>(readFileSync(p, "utf8"))` → `readLocalJSONFile<T>(p)`, type argument carried      |
| `negative-sync-context`            | a sync function, a top-level statement and a non-async callback are all left alone                    |
| `negative-cascade-refused`         | a module-scope caller and a name passed as a value each refuse the whole closure                      |
| `negative-sync-fallback-is-opt-in` | without `syncFallback=true`, an unreachable call stays as it is                                       |
| `edge-unread-shapes`               | a read return value, a `latin1` encoding, stat options and an unrecognized removal are all left alone |
| `edge-shebang-and-existing-import` | the import lands below a shebang and a `@copyright` block, and merges into an existing import         |
| `edge-cascade-boundaries`          | a recursive call is awaited; an annotated binding and a file descriptor are refused                   |

`edge-shebang-and-existing-import` exists because the first run put an import above `#!/usr/bin/env node` in two
executable files — a shebang is a `hash_bang_line`, not a `comment` — and added a second
`import … from "@mailwoman/core/fs/writers"` beside an existing one, which no formatter merges.
`edge-cascade-boundaries` exists because a recursive `out.push(...walk(child))` left un-awaited reports as a missing
`[Symbol.iterator]` several frames from the cause, and because `readFileSync(0, "utf8")` reads STDIN — the first
argument is a DESCRIPTOR, and no path helper accepts one.

## The rule that keeps it done

`mailwoman/no-sync-fs-in-async` in `oxlint.plugin.ts` reports the same position this codemod rewrites, and names the
specific helper. It is silent in the 982 synchronous-context sites, so it stays a finding about a blocked event loop
rather than a style preference.
