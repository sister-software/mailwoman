# @mailwoman/repo-health

This private package holds the repository health checks as a registry. Each check inspects the checkout and returns
diagnostics or pass/fail. `mwops health <id>` runs one check, and `mwops health all` runs the whole registry.

A check may only inspect and report. Mutations, generation, publishing, benchmarks, probes, and one-shot migrations
belong elsewhere. Code that needs to write something is a release operation or a CLI command. Two exports sit beside
the registry and are never registered in it: `lib/baseline.ts` writes the debt baseline, and `lib/fixes.ts` plus
`lib/move/` apply the mechanical repair that a check's diagnostic describes.

`lib/registry.ts` is the package's only executable entry point. A check file that is not registered is dead code, and
knip reports it.

## Source-comment triage

`yarn comments:triage [database-path]` scans every tracked `.ts` and `.tsx` source file (excluding declarations and
build output) and writes a local SQLite inventory. Each scanner-recognized line, block, and JSDoc comment retains its
repo-relative path, exact offsets and line/column range, syntax kind, text, and content hash. The default artifact is
`.cache/mailwoman/comment-triage.sqlite`.

The `comment_triage_lead` table contains low-confidence leads for `outdated`, `sensational`, `unclear`, and
`overly_verbose` wording. The leads form a review queue and do not edit source. A person confirms a lead before
changing code.

## Checks

| id                            | what it reads                                                                                                                                                                                                 | spawns  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `version-sync`                | every `.release-it.json` workspace's manifest version against the root's                                                                                                                                      | —       |
| `test-interface`              | every tracked test sits under `test/{unit,integration,full}/` (plus `browser`, `build`, `e2e` where a `playwright.config.ts` runs them) and imports by package name                                           | —       |
| `node-modules-reacharound`    | no `join`/`resolve` argument spells a `node_modules` layout outside the reasoned allowlist                                                                                                                    | —       |
| `runtime-flags`               | every flag in `docs/engineering/reference/runtime-flags.mdx` is touched by a test                                                                                                                             | —       |
| `no-root-scripts`             | the absence of a root `scripts/` directory, of any path built into one, and of any CI target running one or a bare `lib/*.ts`                                                                                 | —       |
| `manifest-targets`            | every `exports`/`imports` target resolves to a tracked source or data file (`out/` mapped to `lib/`)                                                                                                          | —       |
| `prefix-directories`          | three or more siblings sharing a hyphen prefix live under a directory named for it (`usgov/nppes/` rather than `usgov-nppes/`); a workspace directory and a directory holding no TypeScript are never members | —       |
| `private-name-shadows-export` | a module-private function in `packages/*/lib` that shares its name with a function another module exports, which is a copy or a collision, reported per site; the `debt` counter pins the count               | —       |
| `module-surface`              | a module's count of top-level interfaces, constants, functions, and divider comments against per-metric limits; advisory, and it claims no decomposition on the author's behalf                               | —       |
| `module-cohesion`             | a module's top-level declarations partitioned by which reference which, reported when two communities share no imported dependency; advisory, and the warning lists both groups                               | —       |
| `debt`                        | the monotonic debt counters against `baseline.json`                                                                                                                                                           | —       |
| `bundle-graph`                | every browser- and Worker-bundled subpath under its platform conditions: no Node builtin on the static graph, dynamic builtin imports only where a row lists them                                             | esbuild |
| `vocab-census`                | every ambiguous-shorthand hit in tracked source, classified by action                                                                                                                                         | Vale    |
| `exports`                     | every export is used, apart from the reviewed compatibility aliases                                                                                                                                           | knip    |
| `typecheck-tests`             | every workspace's `tsconfig.test.json` under `tsc --noEmit`                                                                                                                                                   | tsc     |

`debt` reports a counter that grew as an error and a counter that fell as a warning. Recording the new reading is a
mutation, so no check does it. `mwops health baseline debt` rewrites `baseline.json` through `lib/baseline.ts`, which
the registry does not list.

## Fixes

A check gets a fix when the repair follows mechanically from its diagnostic. `lib/fixes.ts` is that second, much
shorter registry, and `mwops health fix <check> [--dry-run]` runs it. A fix plans module moves and never writes,
because `lib/move/` owns writing.

| id                   | what it moves                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `prefix-directories` | each grouped sibling into its prefix directory, a directory member expanding to one move per file under it |

`lib/move/` is the operation that the fixes share, and it follows one rule: it writes a replacement specifier only if
that specifier resolves to the moved file. Candidates come from the owning package's own `imports`/`exports` patterns,
so the replacement keeps the form the author wrote. A `#` import stays private, a package subpath stays public, and a
relative path stays relative. If any specifier has no candidate that resolves, the whole plan is refused.

A move rewrites three kinds of reference. It rewrites module specifiers. It rewrites `exports`/`imports` targets but
never a subpath key, because the key is the package's interface and consumers should not see a file move underneath
it. It also rewrites repo-relative paths written as text in a hook command, a lint glob or a `Usage:` line. Dated
records under `docs/superpowers/` keep their paths, because a plan describes what was true on its date.

A move cannot see a path assembled from segments. `resolvePackagePath("@mailwoman/dev-mcp", "lib", "hooks",
"vale-response-check.ts")` contains no path to match. `yarn test` detects those cases, and no text sweep finds them. A
specifier that already resolved nowhere before the move is left unchanged.

The fix runs to a fixpoint. Moving `build-outlier-oa.ts` into `build/` leaves `outlier-oa.ts` beside two siblings that
now share `outlier-`, so `mwops health fix` recomputes the plan until the check reports no findings.

Build output is excluded from resolution intentionally. Every subpath map lists `types` first, so a stale
`out/<subpath>.d.ts` can satisfy an import of a source file that has already moved. In one case this let `tsc` report
zero errors on a tree with three imports that Node could not resolve.

The checks share these helpers: `lib/tracked-sources.ts` (a filter over `RepoContext.trackedFiles` that reproduces
`git ls-files` pathspec matching), `lib/ts-ast.ts` (the import-specifier walk, by node for a rewriter and by text for a
counter), and `lib/context.ts` (collects a `RepoContext` from a live checkout).

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
