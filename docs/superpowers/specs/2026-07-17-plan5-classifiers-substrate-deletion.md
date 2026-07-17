# Plan 5 — classifiers workspace + shared-substrate deletion (v7.0.0 endgame) — implementation spec

**Date:** 2026-07-17
**Status:** Spec draft (design only — no source edits in this branch)
**Parent design:** [`2026-07-12-legacy-rules-excision-design.md`](./2026-07-12-legacy-rules-excision-design.md) — steps 5–8 of the Execution order.
**Predecessor:** Plan 4 (PR #1151) deleted the rules **parser** logic + gold + tests (−9650 LOC) and sealed tag `legacy-rules-final`. The shared-substrate deletion was deferred here because the neural span-head decode consumes `Span`, and `Span`'s base class `Graph` lived in `core/tokenization/` alongside the solver-coupled `context`/`permutate`.

This spec is measured against the working tree at branch point (`main` @ `b7432c42`). Every claim below carries a file:line. Where the parent design's prose disagrees with the measured tree, the correction is flagged **[CORRECTION]**.

---

## 0. What plan 4 already did (measured — do not re-plan)

Several items the parent design lists as "rehome before deletion" or "delete" are **already done** in this worktree. Verified absent / moved:

- **`core/parser/` does not exist** (`AddressParser.ts`, `solution-to-proposals.ts`, `proposal-pipeline.ts` — all gone). Design steps 3 ("move `proposal-pipeline.ts`") and the `core/parser/*` deletion rows are **no-ops**. (`find core/parser` returns nothing; only stale sibling git-worktrees under `.claude/worktrees/*` still carry copies.)
- **`core/solvers/` (plural) does not exist.** The `core/solvers/*` deletion row is a no-op for source; only the stale **exports-map entry** `./solvers/*` remains in `core/package.json` (both maps) and must be pruned.
- **`Classification.ts` is already at `core/types/Classification.ts`.** Design step 1 (rehome `Classification.ts` → `core/types/`) is **done**. `core/tokenization/Span.ts:14` already imports it via the deep path `../types/Classification.ts`.
- **`legacyClassificationToComponentTag` + the taxonomy bridge already live in `core/types/mapping.ts`** (retained by design §Projection).
- **No survivor depends on the `@mailwoman/core/classification` barrel.** `formatter/format.ts:27` imports `ClassificationMap` / `VisibleClassification` from `@mailwoman/core/types`; grep across `formatter/ neural/ phrase-grouper/ core/decoder/ core/policy/ core/types/` for imports from `@mailwoman/core/classification` returns **empty**.

Net: plan 5 is **pure deletion + edge-severing**, not rehoming. The "rehome contracts" phase collapses to a one-line verification.

---

## 1. Dependency map (measured)

### 1a. Non-test source importers of `@mailwoman/classifiers`

The **only runtime source importer in the entire repo** is the umbrella:

- `mailwoman/index.ts:13` — `export * from "@mailwoman/classifiers"`

Everything else is config / tooling / generated:

| File:line | Kind | Action |
| --- | --- | --- |
| `mailwoman/package.json:153` | `"@mailwoman/classifiers": "workspace:*"` dep | remove |
| `mailwoman/tsconfig.json:22` | `{ "path": "../classifiers" }` project ref | remove |
| `tsconfig.json:30` (root) | `{ "path": "./classifiers" }` project ref | remove |
| `package.json` (root) `workspaces` | `"classifiers"` entry | remove |
| `scripts/rewrite-workspace-imports.ts:41` | `[/^mailwoman\/classifiers$/, "@mailwoman/classifiers"]` | remove map row |
| `scripts/smoke-clean-install.ts:44` | `"@mailwoman/classifiers": "classifiers"` | remove map row |
| `core/types/classifier.ts:15` | docstring mention only | optional prose scrub |
| `mailwoman/eval-harness/fixtures/v1-scheme-inventory.json` | rescued scheme data (comment) | keep (rescued fixture) |
| `docs/{build,static}/sbom/*.{spdx,cdx}.json` | generated SBOMs | regenerate at ship |

**Consequence:** deleting the classifiers workspace is a **single-edge cut at the umbrella**. No other workspace imports it.

### 1b. Importers of `core/tokenization/context`, `Graph`, `permutate` (+ `split`)

| Module | Importers (file:line) |
| --- | --- |
| `context.ts` (`TokenContext`) | barrel `core/tokenization/index.ts:7`; `context.test.ts:10`. **`context.ts` itself imports** `@mailwoman/core/solver` (`context.ts:12`), `./permutate.ts` (`:14`), `./Span.ts` (`:15`), `./split.ts` (`:16`) |
| `Graph.ts` | barrel `index.ts:8`; `Span.ts:15` (`class Span extends Graph<Span>`) |
| `permutate.ts` | barrel `index.ts:10`; `permutate.test.ts:10`; `context.ts:14` |
| `split.ts` (`splitByField`, `fieldsFunc*`) | `context.ts:16`; `split.test.ts:10` — **and nothing else** |

`TokenContext` / `SerializedTokenContext` consumers, all in the dying set: `classifiers/adapter.ts:20`; `core/solver/{HashMapSolver.ts:8, Solution.ts:14, mask.ts:8, BaseSolver.ts:8}`; `core/classification/{SectionClassifier.ts:7, PhraseClassifier.ts:8, BaseClassifier.ts:12, WordClassifier.ts:8}`.

**[CORRECTION]** The parent design (§Contract rehoming item 2) says to keep `split` with consumers "neural, phrase-grouper, decoder, policy." That is **false for `core/tokenization/split.ts`** — its only non-test consumer is `context.ts:16`. The design conflated it with **`corpus/src/split.ts`**, a *different* file (`corpus/src/index.ts:18`, `build.ts:68`, `parquet.ts:46`). The tokenization `split.ts` has **zero surviving consumers** and dies with `context`.

### 1c. What `Span` actually uses from `Graph`

`core/tokenization/Span.ts:41` — `export class Span extends Graph<Span>`. Span relies on inherited members:

- `this.children` (Span.ts:102, :188, :192, :208) — a `Sequence<Span>`
- `this.phrases` (Span.ts:243) and `previousSiblings`/`nextSiblings` (Span.ts:266–270, `connectSiblings`)
- `nextSibling` getter (used by `context.ts:134` coverage walk — but that caller dies; the getter is still Span's inherited API)

`Graph` (`Graph.ts:18`) imports only `Sequence` from `../resources/set.ts` (a pure `extends Set`, Node-free per its header comment). **`Graph` is pure and is `Span`'s base class ⇒ it STAYS.**

`Span` consumers among survivors:

- **value** (`Span.from`): `phrase-grouper/rules.ts:19,117` (`makeSection` → `Span.from`)
- **type-only**: `neural/proposal-classifier.ts:22` (span-head decode; note :66–76 it emits a structurally-Span-shaped record cast `as unknown as Span` and deliberately avoids `Span.from` / graph init), `core/decoder/proposals-to-tree.ts:17`

`TextNormalizer` (`normalizer.ts`) survivor consumers: `core/resources/libpostal.ts:12`, `core/resources/whosonfirst/loader.ts:8`, `core/resources/LocaleIndex.ts:7`.

### 1d. The single entangling edge (why the solver is in the neural graph)

`@mailwoman/core/solver` is runtime-imported by exactly **one** non-solver, non-script file: `core/tokenization/context.ts:12`. Plus the barrel re-export `core/index.ts:13`. Because the tokenization barrel (`index.ts:7`) re-exports `context`, and neural/phrase-grouper/decoder pull `Span` **through that same barrel**, the dead v0 solver is transitively loaded into the neural module graph. **Severing `context` from the barrel and deleting it breaks that edge; the solver then has no live importer.**

Note the cluster is **cyclic**: `context → @mailwoman/core/solver` (context.ts:12) and `solver → @mailwoman/core/tokenization` barrel → `context` (e.g. `core/solver/HashMapSolver.ts:8`). `context` and `core/solver/*` are mutually dependent ⇒ they must die in the **same PR**. Likewise `core/solver/*` imports `@mailwoman/core/classification` (`BaseSolver.ts:7`, `HashMapSolver.ts:7`, `SolutionMatch.ts:7`, `mask.ts:7`, `Solution.ts:13`) and `core/classification/*` imports the tokenization barrel — so solver + classification-machinery + the tokenization dead-substrate form one atomic deletion unit.

### 1e. `@mailwoman/core/classification` machinery importers

`core/classification/index.ts` re-exports `../types/Classification.ts` (STAYS — the taxonomy) **plus** the machinery `BaseClassifier`, `CompositeClassifier`, `PhraseClassifier`, `scheme`, `SectionClassifier`, `WordClassifier` (426 LOC, DIE). Importers of the machinery barrel: `classifiers/adapter.ts:19` (dies), `core/solver/*` (die), `core/index.ts:7` (barrel re-export, prune). No survivor. `Span` reaches Classification types via the **deep** path `../types/Classification.ts` (Span.ts:14), not this barrel — a deliberate cycle-avoidance (Span.ts:10–13) — so removing the machinery barrel does not touch Span.

---

## 2. Stay/die partition — substrate

| Item | Verdict | Rehome / evidence |
| --- | --- | --- |
| `core/tokenization/Graph.ts` | **STAY** (in place) | Base class of `Span` (Span.ts:41); pure (only `Sequence`, Graph.ts:11). |
| `core/tokenization/Span.ts` | **STAY** (in place) | `Span.from` value consumer `phrase-grouper/rules.ts:117`; type consumers neural/decoder. |
| `core/tokenization/normalizer.ts` (`TextNormalizer`) | **STAY** (in place) | `core/resources/{libpostal.ts:12, whosonfirst/loader.ts:8, LocaleIndex.ts:7}`. |
| `core/tokenization/context.ts` (`TokenContext`) | **DIE** | Only consumers are the dying cluster (adapter/solver/classification); it is the edge that drags `@mailwoman/core/solver` into the neural graph (context.ts:12). |
| `core/tokenization/permutate.ts` | **DIE** | Only non-test consumer is `context.ts:14`. |
| `core/tokenization/split.ts` | **DIE** | Only non-test consumer is `context.ts:16`. **[CORRECTION]** design's "keep split" refers to `corpus/src/split.ts`, a different file. |
| `core/solver/` (whole dir, 752 LOC) | **DIE** | Freed once the `context → solver` edge is cut; cyclic with `context`, dies same PR. |
| `core/classification/{Base,Composite,Phrase,Section,Word}Classifier.ts + scheme.ts` (426 LOC) | **DIE** | Machinery; no survivor importer. `Classification.ts` already lives in `core/types/`. |
| `classifiers/` workspace (4388 LOC incl. tests) | **DIE** | Sole importer is the umbrella `mailwoman/index.ts:13`. |

**Contract rehoming — status: COMPLETE before plan 5 starts** (§0). `Classification.ts` → `core/types/` (done). `mapping.ts` / `legacyClassificationToComponentTag` → `core/types/` (done, stays). `proposal-pipeline.ts` — moot (`core/parser/` already deleted). The plan-5 "rehome" step is a **verification grep**, not a move: confirm no survivor imports `Classification*` from `@mailwoman/core/classification` (currently true) and that `core/types` still exports the taxonomy the formatter/decoder read.

Follow-on orphan (design deletion inventory, optional in the deletion PR): `prepareLocaleIndex()` + libpostal-**loader** machinery in `core/resources` lose their only callers (`classifiers/GivenNameClassifier.ts:7`, `WhosOnFirstClassifier.ts:11`) once classifiers is gone. The libpostal **data** (`core/data/libpostal/*.txt`) stays (corpus + FST builders read it raw). Deleting the loader is harmless-if-orphaned; fold in or file as cleanup.

---

## 3. Contract rehoming (confirm-only)

| Contract | Source (measured) | Target | Status |
| --- | --- | --- | --- |
| `Classification` string-set + `ClassificationMatch` / `ClassificationsMatchMap` | `core/types/Classification.ts` | `core/types/` | already there; Span.ts:14 + classification/index.ts:7 re-export it |
| `legacyClassificationToComponentTag`, taxonomy bridge | `core/types/mapping.ts` | `core/types/` (retained) | already there |
| `ClassificationMap` / `VisibleClassification` (formatter reads) | `@mailwoman/core/types` | unchanged | formatter/format.ts:27 already points at `/types` |
| `proposal-pipeline.ts` | — | — | `core/parser/` already deleted (plan 4) |

No moves required. The one required edit: after deleting `core/classification/index.ts`, ensure any residual re-export of `../types/Classification.ts` that a survivor relied on is instead reached via `@mailwoman/core/types` (measured: none rely on the classification barrel, so nothing to repoint — but re-run the grep as a gate before merging PR 3).

---

## 4. Ordered, CI-green PR breakdown

Constraint: `yarn compile` + `ci:test` green at every merge. Deletion must proceed **consumer-before-dependency**; the cyclic cluster (§1d) forces some deletions into one atomic PR. `yarn compile` (per AGENTS.md) must precede any CLI/test verification — stale `out/` masks missing refs.

### PR 1 — Sever the umbrella edge (`mailwoman → classifiers`)
- `mailwoman/index.ts`: delete line 13 `export * from "@mailwoman/classifiers"` (and the now-stale ordering comment lines 8–12 that reference classifier base classes).
- `mailwoman/package.json`: remove the `@mailwoman/classifiers` dependency (line 153).
- `mailwoman/tsconfig.json`: remove `{ "path": "../classifiers" }` (line 22).
- **Green because:** measured, nothing internal consumes a classifier symbol through the umbrella (only the re-export). `classifiers/` still builds standalone.
- **Migration note (breaking):** `mailwoman` no longer re-exports `@mailwoman/classifiers`; `createAddressParser()` already removed in plan 4. Record in the migration guide.

### PR 2 — Delete the `classifiers/` workspace
- `rm -rf classifiers/`.
- Root `package.json`: drop `"classifiers"` from `workspaces`.
- Root `tsconfig.json`: drop `{ "path": "./classifiers" }` (line 30).
- `scripts/rewrite-workspace-imports.ts`: drop the classifiers map row (line 41).
- `scripts/smoke-clean-install.ts`: drop the classifiers map row (line 44).
- **Green because:** PR 1 removed the sole importer.

### PR 3 — Delete the core rules cluster (atomic) + prune barrels + **both exports maps**
This is one PR because the cluster is mutually dependent (§1d).
- Delete `core/solver/` (whole dir).
- Delete `core/classification/{BaseClassifier,CompositeClassifier,PhraseClassifier,SectionClassifier,WordClassifier}.ts` + `scheme.ts` + their `.test.ts`; delete `core/classification/index.ts` (whole dir — `Classification.ts` already lives in `core/types/`).
- Delete `core/tokenization/{context,permutate,split}.ts` + `{context,permutate,split}.test.ts`.
- `core/tokenization/index.ts`: reduce to `export * from "./Graph.ts"; "./normalizer.ts"; "./Span.ts"` (drop `./context.ts` line 7 and `./permutate.ts` line 10). **#481-sensitive edit — see Risk R1.**
- `core/index.ts`: drop `export * from "./classification/index.ts"` (line 7) and `export * from "./solver/index.ts"` (line 13).
- `core/package.json` — **update BOTH the `exports` and `publishConfig.exports` maps**: remove `./classification`, `./solver`, and the stale `./solvers/*` entries from each. (AGENTS.md: a subpath present in only one map ships broken.)
- Pre-merge gate: re-run the survivor-import grep (§3) — must stay empty.
- **Green because:** after PR 2 the only importers of solver/classification/context were the classifiers workspace (gone) and each other (deleted together here).

### PR 4 — Seal + deprecate + docs
- `npm deprecate @mailwoman/classifiers` → migration-guide pointer (tag `legacy-rules-final` already exists from plan 4; registry is the archive).
- Migration guide + docs scrub (rules-baseline references in runbooks/READMEs; SBOM regen so `@mailwoman/classifiers` drops from `docs/{build,static}/sbom/*`).
- Optional cleanup: delete orphaned `prepareLocaleIndex()` + libpostal-loader in `core/resources` (data stays).
- Ship v7.0.0 via CI publish (rides #875 `Us`-casing batch + `writeJsonl` straggler per parent design step 9).

**Steps that touch BOTH exports maps:** PR 3 only (`core/package.json` `exports` + `publishConfig.exports`). No survivor subpath is added, so no new dual entries — this is pure removal from both.

---

## 5. Risk register

- **R1 — import-cycle #481 (the tokenization barrel edit, PR 3).** Trimming `core/tokenization/index.ts` re-enters the bare-import + subpath-interleave hazard: survivors pull `Span` through this barrel while `core/resources` pulls `TextNormalizer` through it and is itself pulled by the WOF/libpostal loaders. Removing `context`/`permutate` reduces the surface, but verify `neural`, `phrase-grouper`, `core/decoder`, and `classifiers/adapter.test.ts`-style side-effect-import consumers still resolve `Span`/`TextNormalizer` as **defined values, not `undefined`**. Gate: `yarn compile` clean **and** run `core` + `neural` vitest (the suites that historically surfaced "Class extends value undefined"). Keep any existing side-effect `import "@mailwoman/core"` guards.
- **R2 — exports-map dual-update (PR 3).** Removing `./classification` / `./solver` / `./solvers/*` from only one of the two maps in `core/package.json` ships a package that resolves locally (dev `node → .ts` map) but 404s for consumers (published `publishConfig` map), or vice-versa. Verify against a real `yarn pack` tarball's `package.json` before ship.
- **R3 — `@mailwoman/neural` span decode.** Neural imports `Span` **type-only** (`proposal-classifier.ts:22`) and deliberately avoids `Span.from` (`:66–76`). Deleting `context`/`permutate`/`solver` must not touch `Span.ts` or `Graph.ts`. Regression check: `mailwoman eval gate` + demo presets (eval-model skill) on the neural pipeline after PR 3 — the span head must decode unchanged. `Graph` STAYS precisely because `Span extends Graph` (Span.ts:41); do not "tidy" it away.
- **R4 — atomicity of the cyclic cluster (PR 3).** Splitting solver / classification-machinery / tokenization-substrate across PRs breaks `yarn compile` mid-sequence (mutual imports, §1d). They must land together. If the PR is too large to review, split by *review commits within one PR*, not separate merges.
- **R5 — stale sibling worktrees.** `core/parser/` + `core/solvers/` still exist under `.claude/worktrees/*` (dozens of copies). They are not part of the tracked tree; do not let a grep over `.claude/worktrees/**` reintroduce them into the plan. All measurements here exclude those paths.
- **R6 — split.ts [CORRECTION] propagation.** Anyone executing straight from the parent design will try to *keep* `core/tokenization/split.ts` and its 3 `fieldsFunc*` exports. Measured: zero surviving consumers → delete it. Do not preserve dead exports on the barrel.

---

## Appendix — LOC to be removed (measured)

| Unit | LOC |
| --- | --- |
| `classifiers/` (incl. tests) | 4388 |
| `core/solver/` | 752 |
| `core/classification/` machinery (excl. `Classification.ts`, already in `types/`) | 426 |
| `core/tokenization/{context,permutate,split}.ts` + tests | 1071 |
| **Total (plan 5)** | **~6637** |
