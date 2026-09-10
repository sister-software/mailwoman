# @mailwoman/repo-health

Private. Repository health checks as a registry: each check inspects the checkout and returns diagnostics or
pass/fail. `mwops health <id>` runs one; `mwops health all` runs the registry.

Admission rule: a check inspects and reports. No mutation, generation, publishing, benchmark, probe, or one-shot
migration lives here — a check that wants to write something is a release operation or a CLI command, not a check.
Two exports sit beside the registry and are never in it: `lib/baseline.ts` writes the debt baseline, and `lib/fixes.ts`
plus `lib/move/` apply the mechanical repair a check's diagnostic describes.

`lib/registry.ts` is the package's only executable entry point. A check file that is not registered is dead code and
knip reports it.

## Checks

| id                            | what it reads                                                                                                                                                                    | spawns  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `version-sync`                | every `.release-it.json` workspace's manifest version against the root's                                                                                                         | —       |
| `test-contract`               | every tracked test sits under `test/{unit,integration,full}/` (plus `browser`, `build`, `e2e` where a `playwright.config.ts` runs them) and imports by package name              | —       |
| `node-modules-reacharound`    | no `join`/`resolve` argument spells a `node_modules` layout outside the reasoned allowlist                                                                                       | —       |
| `runtime-flags`               | every flag in `docs/engineering/reference/runtime-flags.mdx` is touched by a test                                                                                                | —       |
| `no-root-scripts`             | no root `scripts/` directory, no path built into one, no CI target running one or a bare `lib/*.ts`                                                                              | —       |
| `manifest-targets`            | every `exports`/`imports` target resolves to a tracked source or data file (`out/` mapped to `lib/`)                                                                             | —       |
| `recipe-prefix-directories`   | a repeated hyphen prefix among direct `packages/corpus/lib/recipes/` children is a directory (`fr/admin-split.ts`, not `fr-admin-split.ts`)                                      | —       |
| `private-name-shadows-export` | a module-private function in `packages/*/lib` sharing its name with a function another module exports — a copy or a collision, named per site; the `debt` counter pins the count | —       |
| `debt`                        | the monotonic debt counters against `baseline.json`                                                                                                                              | —       |
| `bundle-graph`                | every browser- and Worker-bundled subpath under its platform conditions: no Node builtin on the static graph, dynamic builtin imports only where a row lists them                | esbuild |
| `vocab-census`                | every ambiguous-shorthand hit in tracked source, classified by remedy                                                                                                            | Vale    |
| `exports`                     | every export is used, apart from the reviewed compatibility aliases                                                                                                              | knip    |
| `typecheck-tests`             | every workspace's `tsconfig.test.json` under `tsc --noEmit`                                                                                                                      | tsc     |

`debt` reports a counter that grew as an error and a counter that fell as a warning. Recording the new reading is a
mutation, so it is not a check: `mwops health baseline debt` rewrites `baseline.json` through `lib/baseline.ts`, which
the registry does not list.

## Fixes

A check earns a fix when the repair is a mechanical consequence of its diagnostic. `lib/fixes.ts` is that second,
much shorter registry, and `mwops health fix <check> [--dry-run]` runs it. A fix plans module moves; it never writes,
because writing belongs to `lib/move/`.

| id                          | what it moves                                      |
| --------------------------- | -------------------------------------------------- |
| `recipe-prefix-directories` | each grouped recipe file into its prefix directory |

`lib/move/` is the operation the fixes share, and it holds one rule: a replacement specifier is written only if it
RESOLVES to the moved file. Candidates come from the owning package's own `imports`/`exports` patterns, so the
replacement stays in the family the author wrote — a `#` import stays private, a package subpath stays public, a
relative path stays relative. A specifier with no candidate that resolves refuses the whole plan.

Two things it does not do. It rewrites module specifiers, not path STRINGS: an allowlist keyed by
`packages/corpus/lib/recipes/sub-venue.ts` is invisible to it, and the sweep for quoted workspace paths after a move
is still manual. And a specifier that already resolved nowhere before the move is left alone rather than repaired.

Build output is excluded from resolution on purpose. Every subpath map lists `types` first, so a stale
`out/<subpath>.d.ts` answers for a source file that has already moved — which is how `tsc` reported zero errors on a
tree holding three imports that Node could not resolve.

Helpers checks share: `lib/tracked-sources.ts` (a filter over `RepoContext.trackedFiles` that reproduces `git ls-files`
pathspec matching), `lib/ts-ast.ts` (the import-specifier walk, by node for a rewriter and by text for a counter),
`lib/context.ts` (collects a `RepoContext` from a live checkout).

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
