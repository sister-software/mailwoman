# CI selection

## Summary

- `test.yml` runs a `scope` job first: `yarn mwops ci-scope`.
- That job decides which test suites to run.
- On pull requests, it compares:
  - base commit
  - vs head commit (through merge base)
- Rename detection is off, so moving a file selects both old and new workspaces.

## How selection is computed

The workspace graph uses dependencies from all four manifest dependency fields and literal imports in tracked JS/TS files. It selects changed workspaces and their transitive consumers.

For a source-only change, Vitest then narrows fast and slow test files to those whose module graph reaches a changed module. Tests that import filesystem, module-path, SQLite, or subprocess access also retain their workspace-level selection because they can read inputs without importing them.

Fixture, asset, and local configuration changes retain workspace-level selection. A prose or lint-only change (`*.md`, `.agents/`, or `typos.toml`) selects no test suite, but the static job still checks it. Each root `lib/<dir>` tool tree owns its tests as a separate selection unit.

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
- The Vitest config exclusions and suite boundaries still apply.
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

### Package builds

- Uses published workspaces from `.release-it.json` plus release tooling.

### Lexicon

- Selected by changes affecting `mailwoman` or `@mailwoman/codex`.
- This is broader than the old gazetteer-path list.

## Rust job

Runs the Rust checks (`cargo fmt --check`, `cargo test` and `cargo clippy -D warnings` over the root cargo workspace
with members `packages/mtf/crates/*` and `packages/trainer/crates/*`) when:

- a crate under `packages/mtf/crates/` or the root `Cargo.toml`, `Cargo.lock` or `rust-toolchain.toml` changes, or
- anything under `packages/trainer/` changes, or
- a global/full-run trigger happens

`mtf-core`'s `board_reference` test reads the uncommitted en-us `tokenizer.model`, so this hosted job
does not run it.

## Rust in the fast leg

The training audit and exposure tests load the `mtf-node` addon. Cargo builds it on first use.
`unit-fast` installs the toolchain the root `rust-toolchain.toml` names before its tests start,
and caches the root workspace's build.

The `rust` job caches its cargo builds with `Swatinem/rust-cache` and the libtorch archive under a key on its
pinned version.

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

Workspace dependency chains can fan out. For example, `mailwoman` depends on `@mailwoman/corpus`, and Earth depends on `mailwoman`, so a corpus change selects Earth. Browser and packaging jobs retain this workspace-level selection when module-level selection narrows the Vitest file lists.
