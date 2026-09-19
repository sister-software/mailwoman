# AGENTS.md

Mailwoman is a postal-address parser. The unscoped `mailwoman` package provides the CLI and library.
The repository also contains 74 scoped `@mailwoman/*` packages. The root `workspaces` field expands to
75 workspaces, including `docs`; `readWorkspaceDirectories` in `@mailwoman/core/workspaces` is the
authoritative reader. The root package, `@mailwoman/universe`, is private.

Sixty workspaces publish to npm. `.release-it.json` defines that set. Fourteen workspaces are private,
and `packages/osm` remains unpublished pending ODbL counsel sign-off. Run the workspace check described
in `packages/release-kit/AGENTS.md` after adding or moving a workspace.

Every `packages/*` workspace keeps source under `lib/` and tests under `test/`. `docs/` keeps Docusaurus
source under `src/`. The complete workspace catalog is
`docs/engineering/reference/workspaces.mdx`. The non-workspace directories `corpus-python/`,
`hf-publish/`, `data/`, `evals/`, and `docker/` have their purposes documented in that catalog and their
local READMEs.

## Instruction routing

Before editing a workspace, read the nearest `AGENTS.md` on that path. Codex loads nested instruction
files automatically only when the session starts in their directory, so a session started at the
repository root must read the applicable file explicitly.

- `packages/core/AGENTS.md` covers HTTP clients, filesystem access, paths, module resolution, shared
  helpers, and core's Vite import cycle.
- `packages/mailwoman/AGENTS.md` covers CLI helpers, parser test helpers, ANSI output assertions, and
  interactive Ink tests.
- `packages/corpus/AGENTS.md` covers OpenAddresses acquisition, source timestamps, CSV structure, and
  corpus recipe outputs.
- `corpus-python/launch/AGENTS.md` covers Modal training launches and artifact recovery.
- `packages/release-kit/AGENTS.md` covers publish artifacts, workspace registration, CI releases, and
  partial-release recovery.
- `packages/sqlite/AGENTS.md` covers database construction and the SQL that deliberately remains raw.

Use repository skills for procedures rather than copying their steps into this file:

- `training-arc` before launching or grading a training run.
- `eval-model` before deciding whether a model may ship.
- `mailwoman-release` for every npm publish or model promotion.
- `wof-build` for rebuilding WOF SQLite and FST artifacts.
- `task-intake` for implementation or training work expected to produce a PR or handoff.
- `five-whys` when a failure's cause is not directly established.
- `night-shift` and `morning-shift` for autonomous-shift handoff workflows.

## Read before changing behavior

- `docs/records/site-2026-08/concepts/what-mailwoman-is.mdx` explains the calibrated,
  retrieval-augmented sequence labeler and the grammar/atlas division of labor.
- `docs/engineering/SCOPE.mdx` defines current locale tiers, workstreams, runtime flags, and the live
  roadmap. `plan/README.mdx` and phase documents are historical records.
- `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` defines model evaluation requirements and the D-rule:
  a default-on model or decoder change cannot ship with a known regression against the published model
  on a tier-1 locale.
- `docs/engineering/reference/decoder-grammar.mdx` defines the decoder objective and constraint
  taxonomy. Read it before changing the decoder, a prior, or phrase cohesion.
- `docs/engineering/reference/layer-interface.mdx` defines spatial-layer manifests, coverage, data
  tiers, and the meaning of zero coverage.
- `docs/engineering/reference/poi-layer-runbook.mdx` covers the POI database build and publish path.
- `docs/engineering/reference/coverage-overlay.mdx` covers the demo coverage overlay.
- `RELEASING.md` and the `mailwoman-release` skill govern releases.
- `docs/records/evals/` contains evaluation reports. `evals/scores-by-version.json` is the score ledger.
  The latest `parity-scorecard-*.md` is the human-readable per-tag table.
- `.claude/output-styles/mailwoman-development.md` is the shared communication standard for agents.
  `config/vale/.vale-chat.ini` enforces its mechanical subset for Codex and Claude Code responses.

`docs/engineering/reference/SCHEMA.mdx` is the canonical definition of `ComponentTag`.

## Workspace conventions

Node runs TypeScript source directly through type stripping. Relative imports include `.ts`, and each
compiling workspace uses `rewriteRelativeImportExtensions: true` and `erasableSyntaxOnly: true`. Use a
constant object plus a derived union instead of `enum`. Avoid constructor parameter properties and
runtime namespaces.

A package owns the declarations it exports. Do not re-export a declaration from another
`@mailwoman/*` package or from `mailwoman`. Import the declaration from its owning package. The
`mailwoman/no-cross-package-reexport` lint rule enforces this boundary.

A test imports the package under test through its public package export. Relative imports may name
helpers inside that test directory. Tests must not use the package's private `#` imports. Add an export
for a module that a consumer-facing test must reach. `mailwoman/no-private-import-in-test` and the
`test-interface` repository check enforce these rules.

Each compiling workspace sets `rootDir` to `./lib`; TypeScript therefore emits `lib/x.ts` as
`out/x.js`. Test configurations widen `rootDir` because `test/` sits outside `lib/`. The ten
`neural-weights-*` data packages and `sentencepiece-wasm` compile no TypeScript.

`sdk/` means data acquisition: fetching or extracting source data and implementing a
`RegionDatabaseProvider`. CLI helpers belong in `packages/mailwoman/lib/cli/kit/`, and parser test
helpers belong in `packages/mailwoman/lib/test-kit/`. The
`no-serve-package-to-build-tooling` dependency rule prevents request-path packages from importing any
workspace's `lib/tools/` or `lib/sdk/` directory.

Use the established shared implementation before adding a local helper. `mailwoman/prefer-home` and
the `private-name-shadows-export` repository check report repeated implementation shapes and private
names that collide with exports. Price the dependency before moving code into a shared package;
`nuts-lookup`, `timezone-lookup`, and the GBT test
retain documented local implementations to avoid large dependency graphs. When two platforms must
agree on behavior, share the function rather than copying its constants.

The acronym convention capitalizes each acronym as a complete camel-case component: `createWOFResolver`,
`parseJSON`, `readID`, and `modelURL`. Preserve external names, snake-case wire fields, and documented
CLI adapter keys. `sister-software/no-title-case-acronym` enforces the convention.

Run `yarn lint` for lint, formatting, prose, dependency, and repository-health checks. Run
`yarn typecheck` for build and test type checking. Run the narrow package tests during iteration and
the affected workspace's complete tests before handoff. Do not claim a command passed unless it ran.

## Moving a workspace

After moving a workspace, search quoted path literals whose first segment is the old workspace name.
The compiler does not inspect CI commands, CLI defaults, hook patterns, and test skip conditions. Keep
data-root-relative paths and package specifiers unchanged when they are not filesystem references.
CodeQL raises existing findings at their new paths; restore justified dismissals after merge. The
required `test` context decides merge eligibility.

## Evidence and diagnostics

State whether a material claim is observed, inferred, decided, or unknown. Give the denominator,
baseline, comparison arm, threshold, artifact version, and measurement conditions when they affect the
interpretation. Preserve exact addresses, identifiers, commands, error messages, hashes, scripts, and
paths.

For an address failure, place the exact input beside the expected and observed results. Identify the
first stage that diverges. If the cause remains unknown, state the smallest test that distinguishes the
remaining explanations. Use the `five-whys` skill before proposing a change when the evidence does not
directly establish the cause.

A reader that can return part of a requested result must report what it read or throw. Do not translate
a missing requested field, unreadable input, or failed projection into zero, `unchanged`, or an empty
collection. Recheck a surprising absence through an independent path before reporting it.

Claims about source structure or scale require a direct measurement of the relevant input tail. Check
quoted newlines, tabs, leading zeroes, unbounded scans, and other cases outside the examples that already
work. Put a measured value in a durable comment only when that value still constrains the implementation.
Put incident history in the issue, PR, commit, or retrospective.

Before adding a fitted threshold, fix the cheapest plausible cause and measure again. Determine whether
that cause produces the separating quantity. Inspect the rows the threshold would newly refuse. A
threshold fitted only to current failures may measure the defect that produced those failures.

## Code review rules

### Default-on model behavior

Flag a default-on model or decoder change when any tier-1 locale regresses against the published model.
The safe paths are to fix the regression, restrict the behavior to the measured locale, or keep the
behavior opt-in. `docs/engineering/CONTRIBUTING_MODEL_WORK.mdx` defines the required evaluation set.

### Partial reads

Flag a reader that converts an unreadable or omitted requested value into a valid-looking absence. The
safe path is to return the requested value with its provenance or raise an error that identifies what
could not be read.

### Data-derived thresholds

Flag a new decision threshold fitted only to rows that fail because of the mechanism being changed. The
safe path is to fix that mechanism, measure the full relevant population, and inspect the newly refused
rows before registering the threshold.

## Repository mechanics

Executable repository code accesses the filesystem through `@mailwoman/core/fs`; paths use `path-ts`.
Data-root artifacts use `@mailwoman/core/data-root`. Package and repository files use the resolvers
documented in `packages/core/AGENTS.md`. The lint and repository-health checks identify violations and
name the owning interface.

Database files are read-only published artifacts. Build a replacement separately, verify it, and swap
it into place. Use Kysely over `node:sqlite`; read `packages/sqlite/AGENTS.md` before changing database
construction or inline SQL.

There is no root `scripts/` directory. Executables enter through a package registry, a `mailwoman`
command, or `packages/mailwoman/lib/dev-tools/*.run.ts`. The `no-root-scripts` repository check enforces
this structure.

Preserve unrelated working-tree changes. Edit files through your agent's file-editing tool or a patch
it applies, so the symbol precheck runs on every edit. A `PreToolUse` hook enforces this by refusing
shell writes inside the repository. Do not use destructive Git commands to discard operator work.
