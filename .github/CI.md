# CI selection

The `scope` job in `test.yml` runs `yarn mwops ci-scope` before conditional test jobs acquire runners.
On a pull request, the command compares the head commit with its merge base against the base commit.
The diff disables rename detection so that a move selects both its old and new workspace.

The graph includes workspace dependencies from all four manifest dependency fields, plus literal
imports and exports in tracked JavaScript and TypeScript files. Source scanning includes tests and
literal dynamic imports. The command selects changed workspaces and their transitive consumers.
Any change inside a workspace selects its tests, including changes to fixtures, assets, and local
configuration. Computed imports rely on declared manifest dependencies.
Literal paths under `corpus-python/` also select the JavaScript workspaces that read those scripts or
fixtures. Calls to `repoRootPath`, `resolvePath`, and `join` with consecutive literal segments record
the joined path. A directory reference selects every change below that directory.

A root configuration change, a shared fixture outside a workspace, an unrecognized path, a removed
workspace, or a workspace manifest change selects every suite. Manifest changes require a full run
because the current graph cannot describe a dependency edge that the change removed. Main pushes and
workflow dispatches also select every suite. A failed graph read fails the required `test` check.

Fast and slow Vitest jobs receive selected test filenames as arguments. The existing Vitest configs
retain their exclusions and suite boundaries. React, planetary, license-worker, Earth, packaging, and
full-scale lexicon work run only when selected. The `opportunity` output selects the browser tests of
the private opportunity map application, a step of the `react` job, when `@mailwoman/opportunity-app`
or a workspace it depends on changes. The packaging job uses the published workspace set
in `.release-it.json`, plus the release tooling. Lexicon selection includes changes that affect
`mailwoman` or `@mailwoman/codex`; this is broader than the previous list of gazetteer paths.

Python lint, type checking, security checks, and tests run in a separate hosted job when a Python file
or anything under `corpus-python/` changes. Global changes and full runs select Python too. This job
caches uv downloads using `corpus-python/uv.lock` and `corpus-python/pyproject.toml`.

Repository-wide formatting, lint, prose, architecture, and health checks continue to run on every PR.
The docs typecheck runs once when the docs workspace is affected. The separate docs build workflow
still has its own selection rules.

Compiled-output caches require an exact match. Their keys include the runner OS and architecture,
build sources, manifests, TypeScript configuration, the dependency lock, and Node/Yarn configuration.
Colocated test files do not invalidate compiled output because build projects exclude those files.
There is no fallback restore of compiled output from a different source tree.

The required `test` job checks that every selected job succeeded. A selected job that fails, is
cancelled, or unexpectedly skips fails that check. The scope summary lists selected suites and affected
workspaces. An unselected suite did not run. The existing data-fleet exception remains: data-dependent
jobs skip when no data runner is available. The required `test` job then emits a partial-check warning.

Workspace-level dependencies can select broad runs. For example, `mailwoman` declares a dependency on
`@mailwoman/corpus`, and Earth declares a dependency on `mailwoman`. A corpus change therefore selects
Earth. A future refinement would need measured dependencies for each source root or job before it could
exclude that consumer safely.
