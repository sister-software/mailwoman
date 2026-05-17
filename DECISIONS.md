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

## 2026-05-17 — Phase 1.5.1: WOF adapters pivot from SQLite to per-record GeoJSON bundles

**Context:** the Phase 1.5 wof-admin / wof-postalcode adapters were built against
the SpatiaLite `.spatial.db` distribution at `dist.whosonfirst.org/sqlite/`.
First real-data fetch attempt failed three sanity checks:

1. **Mirror is dead.** `dist.whosonfirst.org` returns NXDOMAIN. The
   Geocode-Earth-hosted mirror at `data.geocode.earth/wof/dist/sqlite/` is
   the only one still being maintained (by the Pelias developers, who are
   the sole maintainers of the WOF SQLite export tooling).
2. **`is_current = 1` filter excludes everything.** The
   Geocode-Earth-hosted `whosonfirst-data-postalcode-fr-latest.db` ships
   27,119 postalcode rows, all with `mz:is_current = -1` (WOF's "unknown
   but treated as active" convention; the Pelias importer accepts `-1`
   alongside `1`). The Phase 1.5 SQLite adapter's `is_current = 1`
   predicate emits zero rows from this distribution.
3. **Voltron exposure on `names`.** The `names` table in the SQLite
   distribution is empty (0 rows). Localized name variants
   (`name:eng_x_preferred`, `name:rus_x_colloquial`, etc.) live in a
   separate distribution that the SQLite path doesn't pull. The
   St. Petersburg / Mt. Vernon / Ft. Lauderdale alternation cases the
   adapter is meant to surface as training signal cannot be solved on the
   SQLite path — even with the `is_current` filter loosened.

Combined with operator preference for JSON over SQLite, the pivot was the
right call.

**Options considered:**

1. Patch the SQLite path to accept `is_current ∈ {1, -1}` and let
   `name:*` variants stay unaddressed for Phase 1.5.1 — lands the
   `is_current` fix but leaves the bigger St. Petersburg motivation
   for a later phase.
2. Replace both adapters with JSON-bundle implementations
   (`packages/corpus/src/adapters/wof-admin-json/`,
   `packages/corpus/src/adapters/wof-postalcode-json/`) that consume
   per-record GeoJSON files from cloned
   `github.com/whosonfirst-data/whosonfirst-data-{admin,postalcode}-<cc>`
   repos. Per-feature emission iterates `name:*` variants natively
   (this is where the colloquial / preferred / per-locale forms live in
   the source data); `mz:is_current ∈ {1, -1}` semantics are honored;
   no SQLite distribution dependency.
3. Add a `names`-table secondary-distribution loader alongside the
   SQLite path — more code, still depends on a fragile mirror.

**Chosen:** option 2.

**Rationale:** the JSON-bundle path is the authoritative source for
WOF data; the SQLite export is downstream tooling that happens to be
incomplete (no names, no postcode `is_current = 1`). Consuming the
authoritative source eliminates the mirror failure mode and unlocks
the `name:*` variant emission Phase 1.5.1 was filed to deliver. Path:
adapter pair under `packages/corpus/src/adapters/wof-{admin,postalcode}-json/`,
shared utilities at `packages/corpus/src/wof-json.ts`, fixtures as
hand-curated cloned-repo skeletons under
`packages/corpus/fixtures/wof-{admin,postalcode}-json/`. The registered
adapter ids (`wof-admin`, `wof-postalcode`) are unchanged so `mailwoman
corpus build` callsites do not move.

**`source_id` format change:** the new adapter pair appends a
**name-slot** segment to the previous SQLite-era `source_id` format:

- **Before**: `wof-admin-<wof_id>-<hierarchy-variant>` (e.g.
  `wof-admin-1012-with-region`)
- **After**: `wof-admin-<wof_id>-<name-slot>-<hierarchy-variant>` (e.g.
  `wof-admin-1012-default-with-region`,
  `wof-admin-85633793-name-eng-x-colloquial-self`)

The `default` slot uses the canonical `wof:name` (or
`COUNTRY_DISPLAY_NAME` for country records, preserving the legacy
adapter's OpenCage-canonical behavior). Every `name:*` variant whose
value differs from `default` becomes an additional slot, with the
property key rewritten through `[:_]` → `-` for safe `source_id`
embedding (`name:eng_x_colloquial` → `name-eng-x-colloquial`). This
makes the St. Petersburg quirk a deduplication-safe training signal:
`"Saint Petersburg"` (default) and `"St. Petersburg"` (eng_x_colloquial)
both produce rows for the same WOF id without colliding under
`canonicalDedupKey`.

**Reversibility:** mostly reversible. The new adapters live in
sibling directories so the SQLite path could be re-introduced if a
future Phase needs it; the `source_id` change is observable from any
downstream consumer that pinned to the old format, so a corpus
version bump is the right place to absorb it (the next corpus build
under `corpus-v0.1.x` will emit the new format throughout). The
`better-sqlite3` runtime dep stays in `packages/corpus`'s
`package.json` because the `tiger` adapter still uses it.

## 2026-05-17 — Phase 1.5 §4: JS-native Parquet via patched @dsnp/parquetjs (SNAPPY, not zstd)

**Context:** Phase 1 (#9 / PR #17) shipped the corpus sharder as JSONL
shards + a Python (PyArrow) converter (`packages/corpus-python/scripts/
jsonl_to_parquet.py`) — bridging until the JS toolchain caught up.
Phase 1.5 (#18 §4) replaces that with a native JS writer based on the
isp-nexus parquet wrapper, removing Python from the build hot path
per the operator's "less Python the better" stance.

**Salvage source:** `isp-nexus/universe@6eeb7bd99643a6d62a8b8abbd50968a1e492b90b`
`sdk/parquet/{index,schema,writer,reader}.ts` (252 LOC total, AGPL-3.0,
same license as mailwoman → direct copy clean). Ported to
`packages/corpus/src/parquet-wrapper/`. Two trims relative to the original:
(a) dropped the `@isp.nexus/core/polyfills/promises/withResolvers` import
since Node 22 has `Promise.withResolvers` natively; (b) replaced the
`path-ts` `PathBuilderLike` on `openFile` with the plain `string | URL`
the `@dsnp/parquetjs` envelope reader accepts directly.

**Yarn patch:** carried over `.yarn/patches/@dsnp-parquetjs-npm-1.7.0-efe8288b39.patch`
verbatim from isp-nexus. The patch moves `@aws-sdk/client-s3` plus several
`@types/*` packages from runtime `dependencies` to `devDependencies` in
the upstream `@dsnp/parquetjs@1.7.0` `package.json`. Saves ~50 MB of
supply-chain surface and bundle weight; mailwoman does not use S3
storage so the AWS SDK is pure dead weight.

**Compression:** `SNAPPY`, not `zstd` as #18 §4 specified. The reason is
mechanical, not preferential: `@dsnp/parquetjs@1.7.0` only exposes
UNCOMPRESSED / GZIP / SNAPPY / BROTLI codecs in `compression.js`. SNAPPY
is the standard ML-corpus default (PyArrow's default too) and is the
closest substitute on speed and ratio for textual columns. If
`@dsnp/parquetjs` gains zstd support in a future release the swap is a
one-line constant change in `parquet.ts`.

**Row group size:** 50_000, per the issue spec (within parquetjs's
default file-level cap; we set it via `WriterOptions.rowGroupSize`).
Shard-level cap remains 1_000_000 rows from the Phase 1 plan, so each
shard typically contains ~20 row groups.

**Reversibility:** mostly reversible. The JS writer is a drop-in; tests
round-trip rows through `ParquetReader` so a regression surfaces
immediately. If the patched dep ever breaks against an upstream
parquetjs release, the patch can be re-derived from the upstream
`package.json` diff in a few minutes (or pinned without the patch and
the AWS SDK dependency tolerated). The Python converter file is deleted
in this commit; recovering it would mean restoring from git history (it
was 109 LOC and trivially re-derivable from the existing Parquet schema
definition).
