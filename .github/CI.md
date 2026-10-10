# CI selection

## t;ldr

- `test.yml` runs a `scope` job first: `yarn mwops ci-scope`.
- That job decides which test suites to run.
- On pull requests, it compares:
  - base commit
  - vs head commit (through merge base)
- Rename detection is off, so moving a file selects both old and new workspaces.

## How selection is computed

The graph uses:

- workspace dependencies from all 4 manifest dependency fields
- literal `import`/`export` usage in tracked JS/TS files
- tests and literal dynamic imports

Rules:

- Changed workspaces are selected.
- Their transitive consumers are also selected.
- Any change inside a workspace selects that workspace’s tests:
  - fixtures
  - assets
  - local config
- Computed imports fall back to manifest dependencies.
- Literal paths under `corpus-python/` can also select JS workspaces that read those files.
- Calls to `repoRootPath`, `resolvePath`, and `join` with consecutive literal segments are tracked as joined paths.
- Referencing a directory means any change under that directory can select tests.

## When everything runs (full run)

These cases select every suite:

- root configuration change
- shared fixture outside a workspace
- unrecognized path
- removed workspace
- workspace manifest change
- push to `main`
- manual workflow dispatch

Notes:

- Manifest changes force full runs because the graph cannot represent removed dependency edges.
- If graph reading fails, the required `test` check fails.

## Job-specific behavior

- Fast and slow Vitest jobs receive selected test filenames as arguments.
- Existing Vitest config exclusions and suite boundaries still apply.
- These suites only run when selected:
  - react
  - planetary
  - license-worker
  - Earth
  - packaging
  - full-scale lexicon

### Opportunity app

- `opportunity` output controls browser tests for the private opportunity map app (inside the `react` job).
- It is selected when `@mailwoman/opportunity-app` changes, or any workspace it depends on changes.

### Packaging

- Uses published workspaces from `.release-it.json` plus release tooling.

### Lexicon

- Selected by changes affecting `mailwoman` or `@mailwoman/codex`.
- This is broader than the old gazetteer-path list.

## Python job

Runs separate hosted Python checks (lint, type, security, tests) when:

- any Python file changes, or
- anything under `corpus-python/` changes, or
- a global/full-run trigger happens

Caching:

- uv download cache key uses root `uv.lock` and `pyproject.toml`.

## Always-on checks

- Repository-wide formatting, lint, prose, architecture, and health checks run on every PR.
- Docs typecheck runs once when the docs workspace is affected.
- Docs build workflow keeps separate selection rules.

## Compiled-output cache behavior

- Cache restore requires an exact key match.
- Keys include:
  - runner OS + architecture
  - build sources
  - manifests
  - TypeScript config
  - dependency lock
  - Node/Yarn config
- Colocated test files do not invalidate compiled output (build projects exclude those files).
- No fallback restore from a different source tree.

## Required `test` check semantics

- Required `test` passes only if every selected job succeeds.
- Required `test` fails if a selected job:
  - fails
  - is cancelled
  - unexpectedly skips
- Scope summary shows selected suites and affected workspaces.
- If a suite was not selected, it did not run.

Data-fleet exception:

- Data-dependent jobs can skip when no data runner is available.
- In that case, required `test` emits a partial-check warning.

## Why selection can be broad

- Workspace dependency chains can fan out.
- Example:
  - `mailwoman` depends on `@mailwoman/corpus`
  - Earth depends on `mailwoman`
  - so a corpus change selects Earth
- Narrower selection would require measured per-source-root or per-job dependencies.
