# @mailwoman/repo-health

Private. Repository health checks as a registry: each check inspects the checkout and returns diagnostics or
pass/fail. `mwops health <id>` runs one; `mwops health all` runs the registry.

Admission rule: a check inspects and reports. No mutation, generation, publishing, benchmark, probe, or one-shot
migration lives here — a check that wants to write something is a release operation or a CLI command, not a check.

`lib/registry.ts` is the package's only executable entry point. A check file that is not registered is dead code and
knip reports it.

## Checks

| id                         | what it reads                                                                                       | spawns |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| `version-sync`             | every `.release-it.json` workspace's manifest version against the root's                            | —      |
| `test-contract`            | every tracked test sits under `test/{unit,integration,full}/` and imports by package name           | —      |
| `node-modules-reacharound` | no `join`/`resolve` argument spells a `node_modules` layout outside the reasoned allowlist          | —      |
| `runtime-flags`            | every flag in `docs/engineering/reference/runtime-flags.mdx` is touched by a test                   | —      |
| `no-root-scripts`          | no root `scripts/` directory, no path built into one, no CI target running one or a bare `lib/*.ts` | —      |
| `debt`                     | the monotonic debt counters against `baseline.json`                                                 | —      |
| `vocab-census`             | every ambiguous-shorthand hit in tracked source, classified by remedy                               | Vale   |
| `exports`                  | every export is used, apart from the reviewed compatibility aliases                                 | knip   |
| `typecheck-tests`          | every workspace's `tsconfig.test.json` under `tsc --noEmit`                                         | tsc    |

`debt` reports a counter that grew as an error and a counter that fell as a warning. Recording the new reading is a
mutation, so it is not a check: `mwops health baseline debt` rewrites `baseline.json` through `lib/baseline.ts`, which
the registry does not list.

Helpers checks share: `lib/tracked-sources.ts` (a filter over `RepoContext.trackedFiles` that reproduces `git ls-files`
pathspec matching), `lib/ts-ast.ts` (the import-specifier walk), `lib/context.ts` (collects a `RepoContext` from a
live checkout).

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
