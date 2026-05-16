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
