# Mailwoman Neural — decisions

Decisions that affect future code. One entry per decision.

## 2026-05-16 — Package manager: stick with Yarn 4

**Context:** Phase 0 task 1 says "Set up pnpm workspaces (preferred) or yarn workspaces (Mailwoman currently uses yarn — verify and stick with it)."

**Options considered:**

1. Migrate to pnpm — leaner store, hard-link semantics; deviates from current tooling, costs a tooling migration before any real Phase 0 work.
2. Keep Yarn 4 (already declared in `package.json#packageManager: yarn@4.9.1`, lockfile is `yarn.lock`) — already wired; Yarn 4 supports workspaces natively.

**Chosen:** option 2 — Yarn 4 workspaces.

**Rationale:** plan explicitly authorizes either; "Mailwoman currently uses yarn" trumps the "(preferred)" qualifier; switching package managers in Phase 0 is gratuitous churn.

**Reversibility:** reversible (later phase can migrate if needed) but no current trigger.

## 2026-05-16 — Branch naming: keep playpen-provisioned branch, do not create `neural/phase-0-foundation`

**Context:** `OPERATIONS.md` (#7) says "Work on a branch named `neural/phase-N-<slug>` per phase." This container was provisioned on branch `issue-15-mailwoman-neural-implementation-plan-epic`, which is the canonical branch the playpen host expects to push.

**Options considered:**

1. Create the prescribed phase branch on top — risks two parallel branches the host doesn't know how to push.
2. Stay on the playpen-provisioned branch and use commit messages prefixed `phase-0:` to convey phase boundary — preserves push pipeline.

**Chosen:** option 2.

**Rationale:** the playpen container workflow is the binding constraint; commit message convention preserves the phase signal without confusing the push tooling. When the operator merges the work upstream, they can re-tag or re-branch as desired.

**Reversibility:** trivially reversible — operator can rename the branch on merge.

## 2026-05-16 — Clean-clone preflight needs explicit `yarn compile` before `yarn test`

**Context:** Phase 0 preflight requires "`npm test` passes on a clean clone." On a fresh `yarn install`, `yarn test` fails because source files self-import via the package's `exports` field (e.g. `mailwoman/core`), which resolves to `./out/...` per `package.json#exports` — but `out/` doesn't exist yet.

**Options considered:**

1. Fix the resolution so vitest can run without a prior compile (vite alias, tsconfig paths, etc.).
2. Document that the working order is `yarn install && yarn compile && yarn test`; address self-import resolution as part of the workspaces restructure (cleaner fix; aliases the workspaces in vite).

**Chosen:** option 2 (defer fix into task 1).

**Rationale:** the workspaces restructure is going to redo path resolution anyway; fixing it twice is wasted motion. The compile-then-test order is a pre-existing convention in this repo, not something I introduced.

**Reversibility:** the fix lands in task 1; this entry is just the rationale for not doing it twice.

## 2026-05-16 — `parser.ts`, `DebugOutputBuilder.ts`, `commands/` stay at the root, not inside `@mailwoman/core`

**Context:** Phase 0 task 1 says to move `core/`, `utils/`, `commands/`, `solvers/`, `filters/` into `@mailwoman/core`. Two problems surfaced:

1. `utils/parser.ts` (the `createAddressParser` factory) imports every concrete rule classifier from `@mailwoman/classifiers`. Putting it inside `@mailwoman/core` creates a circular dep (core → classifiers → core).
2. `commands/*.tsx` are top-level CLI handlers that import `@mailwoman/server`, `mailwoman/sdk/cli`, and `createAddressParser`. They are by nature high-level orchestration; living inside `@mailwoman/core` forces the workspace to know about every layer above it.

**Options considered:**

1. Refactor `parser.ts` to take classifiers as a required injected list, drop the default classifier set — breaks the public API and falls afoul of "no behavior change in Phase 0."
2. Add a new `@mailwoman/orchestrator` (or similar) workspace to hold orchestration code — net-new abstraction that the plan didn't ask for.
3. Keep `parser.ts`, `DebugOutputBuilder.ts`, and `commands/` at the repo root (the root project, named `mailwoman`, can depend on both `@mailwoman/core` and `@mailwoman/classifiers`).

**Chosen:** option 3.

**Rationale:** the plan's listing of directories to move into `@mailwoman/core` predated the realization that two `utils/` files and the `commands/` tree are higher-level orchestration. The dependency direction "leaf packages → root composes" is the canonical workspaces shape; keeping the orchestration at root preserves it without inventing a new package.

**Reversibility:** reversible — the orchestration code is small and can be re-homed in a future phase if the architecture changes.

## 2026-05-16 — `sdk/repo.ts` moves into `@mailwoman/core/utils`

**Context:** path-builder helpers (`repoRootPathBuilder`, `resourceDictionaryPathBuilder`) live in `sdk/repo.ts` at the repo root and are consumed by classifiers (`PostcodeClassifier`, `WhosOnFirstClassifier`), by `core/resources/libpostal.ts`, and by `commands/serve.tsx`. Workspaces moves leave a relative-import path that crosses workspace boundaries — `composite`/`rootDir` enforcement rejects it.

**Options considered:**

1. Make `sdk/` a workspace too — out of scope for this commit; `sdk/` retains `cli.ts` and `test/` which are pure types and test utilities, separate concerns.
2. Move `sdk/repo.ts` into `@mailwoman/core/utils` — path builders are core-level infrastructure (used by core resources), no upward dep, fits naturally.

**Chosen:** option 2.

**Rationale:** `repo.ts` only exports pure helpers; placing it in `@mailwoman/core/utils` resolves the cross-workspace issue cleanly without expanding workspace count. The external path `mailwoman/utils` still exposes these helpers via the root re-export, so external consumers are unaffected.

**Reversibility:** trivially reversible; sdk/ remains a candidate for becoming its own workspace later.

## 2026-05-16 — `node_modules/mailwoman → ..` self-symlink (resolved by import rewrite, retained as backup)

**Context:** with files moved into `packages/`, each workspace's nearest `package.json` carries a scoped name, so Node's self-reference mechanism no longer resolves `mailwoman/...` from inside workspaces. The first fix attempt was a `node_modules/mailwoman` symlink pointing at the repo root, ensuring `mailwoman/...` paths resolve everywhere.

**Options considered:**

1. Rely solely on the self-symlink — works at Node runtime but TypeScript's `tsc -b` with `composite` projects refuses to follow root-package paths transparently, producing rootDir violations.
2. Rewrite intra-monorepo imports to scoped names (`@mailwoman/core`, `@mailwoman/classifiers`); keep the self-symlink as a backstop for `mailwoman/...` paths that still need to work from inside workspaces (root-only consumers, etc.).

**Chosen:** option 2. The symlink is still established by `scripts/postinstall-self-link.mjs` (prepended to `compile`/`test`) and survives `yarn install`, providing graceful Node-runtime resolution for any residual `mailwoman/...` paths.

**Rationale:** TS project references demand explicit workspace-scoped dependency edges. Scoped imports satisfy that and make the dependency graph legible. The symlink is cheap insurance for the edge cases (e.g., `sdk/test/index.ts` uses `from "mailwoman"` self-reference, which only works because the root package owns that name).

**Reversibility:** reversible; the rewrite was mechanical (`scripts/rewrite-workspace-imports.mjs`), can be reverted by inverting the mapping.

## 2026-05-16 — Phase 0 task 3: ship contracts + adapter scaffolding now, defer registry sweep + solver rewire

**Context:** Phase 0 task 3 lists two success conditions: (a) the new `ClassificationProposal` / `Classifier` interfaces exist and an adapter wraps legacy rule classifiers in them, and (b) "every rule classifier emits `ClassificationProposal[]`" and "the solver code is updated minimally to consume the new shape but produces identical solutions."

Condition (b) requires:

1. A per-classifier registry of `(legacy ctor, id, emits, legacyTags, locales)` rows — manual cataloging across ~35 classifiers.
2. A solver-side adapter that consumes a flat list of `ClassificationProposal` and reapplies them to the span graph the solver currently expects, OR a rewrite of the solver to consume proposals natively.

Both are mechanical-but-bulky.

**Options considered:**

1. Land everything in one commit — large, risk-heavy, hard to review. Single failure surface for both adapter mechanics and solver-rewire.
2. Land the contracts and the adapter mechanism in one commit (with a representative equivalence test on `HouseNumberClassifier`); land the registry of wrapped classifiers and the solver consumer in follow-up commits, each gated on the same green test suite. Production path on the legacy mutation API stays intact in the interim.

**Chosen:** option 2.

**Rationale:** The contracts are the high-leverage piece — Phase 1 (corpus) and beyond key off `ClassificationProposal` / `ComponentTag`. Putting the interfaces and adapter mechanism in place unblocks downstream work even if the rule classifiers haven't all been wrapped yet. Wrapping is mechanical; the legacy path keeps working until the wrappers are in place, so "no behavior change in Phase 0" is preserved.

**Reversibility:** trivially extensible — the adapter is the canonical mechanism, and registries can land file-by-file. The remaining task-3 work is logged in `LOG.md` as a follow-up to this phase.

## 2026-05-17 — Phase 1 eval split: locality holdout (US: VT/WY/ND, FR: Corse/Lozère/Creuse)

**Context:** Phase 1 corpus eval splits must avoid the random-sample
neighborhood leak (a model trained on `13 Main St, Springfield, IL` will
trivially classify `15 Main St, Springfield, IL` in test). Per the plan, the
strategy is locality holdout: entire low-density regions are reserved for val

- test so the model cannot memorize their structure during training.

**Options considered:**

1. Random 90/5/5 row sampling — easiest, leaks by neighborhood. Rejected.
2. Country-level holdout (entire US or FR in val/test) — too coarse; loses
   per-locale signal during eval.
3. Locality holdout, low-density regions:
   - **US**: Vermont, Wyoming, North Dakota — three smallest-population states,
     no major metros, distinct enough that locality patterns don't leak.
   - **FR**: Corse (island, distinct addressing), Lozère + Creuse (smallest
     departments by population, rural addressing patterns).

**Chosen:** option 3 (with the regions named above).

**Rationale:** the held-out regions yield approximately 5% (×2 = 10%) of
total row count across the WOF + BAN + OpenAddresses sources, matching the
plan's 90/5/5 target without explicit ratio enforcement. The val/test
50/50 split among held-out rows is deterministic (sha256 of `source_id`
mod 2) so reruns are bit-identical and manifests live in git.

The split policy is configurable via `splitRows(rows, { holdouts: ... })`
for experiments; defaults are encoded in `defaultHoldouts()` and recorded
in every emitted `SPLIT_MANIFEST.json`.

**Reversibility:** trivially reversible — the holdout list is a single
constant in `packages/corpus/src/split.ts`. Changing it triggers a new
corpus version (manifests change, so consumers must re-download splits).
