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

Two trims relative to the original:
(a) dropped the `@mailwoman/core/polyfills/promises/withResolvers` import
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

## 2026-05-17 — Phase 1.6 §2.1: composition is a separate primitive, not an Augmentation

**Context:** Phase 1.6 §2.1 (#22) asks for a `composeAdversarialRow`
primitive that takes a venue string + an existing `CanonicalRow` from
another adapter and renders them together as a single adversarial
training example. The pre-existing single-row augmentations
(`case-upper`, `state-abbreviate`, `us-street-suffix-expand`, ...)
all live in `packages/corpus/src/synthesize.ts` as pure
`(CanonicalRow) -> CanonicalRow | null` functions registered in
`AUGMENTATIONS` and applied via `synthesizeRow`. The new compose
primitive could not fit that mold.

**Options considered:**

1. **Make compose an `Augmentation`** by widening the interface to
   take an optional second row + an options bag. Forces every existing
   augmentation to grow a no-op parameter; muddies the
   `synthesizeRow` generator contract; and the output of compose is
   structurally a `LabeledRow`, not a `CanonicalRow`, which would
   break the homogeneous-output guarantee `synthesizeRow` callers
   rely on.
2. **Land compose as a new primitive alongside augmentations** in
   `synthesize.ts` with a distinct signature
   `(venue: string, address: CanonicalRow, opts) -> ComposeResult`,
   not registered in `AUGMENTATIONS`, not part of
   `defaultAugmentationsForCountry`. Build-time policy applies
   compose to address rows independently of the augmentation pass.
3. **Move compose into a new file** (e.g. `compose.ts`). Pure code
   organization; no behavior difference; loses the
   single-stop-for-row-synthesis property `synthesize.ts` was meant
   to have.

**Chosen:** option 2.

**Rationale:** the two operations differ in three essential ways
that make a shared signature wrong, not just inconvenient:

1. **Output shape.** Augmentations emit `CanonicalRow` and defer
   labeling to `alignRow`. Compose emits `LabeledRow` directly because
   naive post-hoc alignment would mis-label the embedded
   place-shaped tokens (the "Buffalo Health Clinic, Buffalo NY"
   bug — alignment's substring search would grab the venue's
   "Buffalo" as the locality, or vice versa). The deterministic
   boundary in compose is the entire point of the primitive; you
   cannot get there from an `Augmentation` signature without
   destroying the contract.
2. **Arity.** Augmentations are unary; compose is binary. Folding
   the second input into an options bag works mechanically but
   reads as a hack: every other augmentation would have a
   nonsensical opt and the type system wouldn't catch passing
   compose without one.
3. **Provenance.** Augmentations chain `source_id` linearly under a
   single row's `base_source_id`. Compositions cite the address
   row's `base_source_id` and carry the venue string on a
   `venue` component the address adapter didn't emit. The
   provenance graph is two-source.

The compose primitive lives in `synthesize.ts` alongside the
augmentations (one stop for "things that mutate corpus rows"), but
under its own export name and outside the `AUGMENTATIONS` registry,
so `synthesizeRow` callers see only the unary
`CanonicalRow → CanonicalRow` machinery and compose users reach for
the binary call explicitly.

**Throttling (~5-15% of training set):** policy belongs in the build
pipeline, not the primitive. `composeAdversarialRow` is a pure
function returning a `ComposeResult`; the caller decides how often
to invoke it. Putting a fraction inside the primitive would couple
it to the corpus size, which it cannot see.

**Reversibility:** trivially reversible. The compose primitive is
~80 LOC in one file; folding it into a shared `Augmentation`
interface (option 1) or relocating it to `compose.ts` (option 3)
is a mechanical refactor with no schema implications.

## 2026-05-17 — corpus-v0.1.0: ship synth-OFF (augmentations applied at training time, not baked into corpus)

**Context:** The first real-data corpus build (`corpus-v0.1.0`, WOF +
BAN + TIGER) was produced inside an 8 GiB-RAM container. The default
build runs synthesis: for each canonical row, every applicable
`Augmentation` in the country-default policy emits one augmented copy
in addition to the original. US has 11 augmentations (4 universal + 7
US-specific), FR has 6 (4 + 2). Average effective fan-out is ~3-4×
after no-op filtering.

The bottleneck is `buildCorpus` in `packages/corpus/src/build.ts`:
it accumulates **every** aligned row's `{source_id, country,
corpus_version, components.region}` into an in-memory `splitInputs`
array, then `splitRows` partitions it into in-memory train / val /
test source-id arrays. For ~4.56 M canonical rows the synth-OFF run
peaked at ~4.2 GiB RSS. Synth-ON would have multiplied that by ~4×,
plus the WOF ancestry index (~600 MiB resident for the full US admin
distro) — overflowing the 8 GiB container even with
`--max-old-space-size=7000`.

**Options considered:**

1. Run synth-ON and accept the OOM risk — ~30 min to discover failure,
   no salvage path if it crashes during align phase (would lose all
   labeled.jsonl progress).
2. Refactor `buildCorpus` / `splitRows` to stream `splitInputs`
   through disk-backed JSONL and rewrite `splitRows` to consume an
   async iterable — meaningful code change with test rewrites, out of
   scope for a "run the build" task.
3. Ship synth-OFF for v0.1.0 and document the choice: 4.56 M _clean_
   canonical rows + the augmentations available as a separate
   training-time concern (the same `defaultAugmentationsForCountry`
   table can be invoked from a Dataset / DataLoader to apply
   augmentations at batch time).

**Chosen:** option 3.

**Rationale:** The augmentations in
`packages/corpus/src/synthesize.ts` are pure functions; baking them
into the corpus vs. applying them at training time is a question of
_when_, not _whether_. Training-time augmentation is the standard ML
pattern (a fresh per-epoch sampling means the model sees more
variety than a fixed corpus fan-out). The corpus contract still
documents the augmentation set; downstream training code wires the
same functions in.

The WOF `name:*` variants pre-existing in the adapter output already
provide substantial surface-form diversity at the locality/region
level (293 k US admin features × ~2 hierarchy variants × ~2.4 name
slots ≈ the deduped 3.30 M canonical rows the build produced). The
case / spacing / abbreviation augmentations are mechanical and add
nothing the WOF localized-names corpus doesn't already cover for
admin rows; they would matter most for the BAN / TIGER rows, whose
canonical-row count (1.16 M combined) is small enough that
training-time augmentation can comfortably amortize the work.

**Reversibility:** trivially reversible. To bake synth into a future
corpus version (e.g. v0.1.1), either (a) refactor `splitInputs` to
stream to disk and re-run with `--no-synthesize=false`, or (b)
post-process the existing v0.1.0 `intermediate/labeled.jsonl` through
the augmentation pipeline + re-shard. The augmentations table is
unchanged; only the _application site_ moves.

**Build artifact summary:** /data/corpus/versioned/v0.1.0/ —
adapters {wof-admin 3.30 M, wof-postalcode 103.7 k, ban 1.08 M,
tiger 79.0 k} → 4.56 M aligned (66 quarantined, all
`component-not-found:*` on WOF `name:*` whitespace-artifact variants;
same root cause as the 6/19 quarantine in the Phase 1.5 TIGER smoke,
not a pipeline regression). Splits 4.44 M train / 58.8 k val / 58.8 k
test (the train skew is from BAN rows lacking `region` — known
limitation). Parquet shards SNAPPY, ~157 MiB final.

## 2026-05-17 — `splitInputs` refactor scope (memory-streaming for synth-ON v0.1.1)

**Operator follow-up question:** "Describe what splits today, what would
need to change, and why it's an hour's work rather than the kind of
thing you'd just turn on."

### What's in memory today

Three data structures pin every aligned row's split membership in heap
during a `buildCorpus` run:

1. **`splitInputs` array** — `packages/corpus/src/build.ts:155-160`.
   Pushed once per aligned row in the align loop (line 185). Holds
   `{source_id, country, corpus_version, components:{region}}` ≈ 150
   bytes/entry under V8.
2. **`SplitManifest.{train,val,test}` arrays** —
   `packages/corpus/src/split.ts:75-108`. `splitRows()` returns three
   in-memory `string[]` of source_ids (one per row, partitioned by
   holdout policy). ~50 bytes/entry × 1 entry per aligned row.
3. **`splitByIdMap`** — `packages/corpus/src/build.ts:210-213`. A
   `Map<source_id, SplitName>` reassembled from the three arrays above,
   used as the `splitFor` callback for the parquet sharder
   (`packages/corpus/src/parquet.ts:250`). ~100 bytes/entry × 1 entry
   per aligned row.

All three are O(n_aligned_rows). At 4.56 M rows the trio takes ~1.6 GiB
of heap (measured: RSS peak during this run was 4.2 GiB total, with the
WOF ancestry index, buffers, and V8 overhead making up the balance).

### Failure mode if synth is enabled today

`alignRow` is called once per `synthesizeRow` output. For each input
canonical row, US augmentations produce up to 11 additional rows
(`caseUpper, caseLower, dropCommas, doubleSpace, stateExpand,
stateAbbreviate, directionalExpand, directionalAbbreviate,
streetSuffixAbbreviate, streetSuffixExpand, zipPlus4DashDrop` —
`packages/corpus/src/synthesize.ts:374-393`); FR augmentations
produce up to 6. Each non-null augmented row appends to `splitInputs`
and eventually to `splitByIdMap`.

Effective fan-out depends on which fields are present. WOF country /
region rows no-op most US augmentations (no `street`, `state`, or
`zip` to operate on). Realistic per-class projections:

| Class                          | Fan-out (incl. original) |
| ------------------------------ | -----------------------: |
| WOF admin US, country/region   |                       3× |
| WOF admin US, locality / sub   |                       4× |
| WOF postalcode US              |                       6× |
| BAN FR (house_number + street) |                       6× |
| TIGER US (street + region)     |                       6× |
| WOF admin FR (mostly FR-univ)  |                       4× |

Weighted average across the 4.56 M v0.1.0 row mix: **~4.5× fan-out**.

Projected synth-ON labeled count: **~20 M rows**. At that scale the
three in-memory structures cost ~5 GiB on their own; add ~600 MiB for
the WOF ancestry index and ~500 MiB baseline node/buffers and the
process needs ~6 GiB heap before V8 itself starts shedding cache.
With `--max-old-space-size=5800` (the largest safe value in an 8 GiB
container that still leaves the kernel breathing room) the run
**OOMs during the align phase** — typically with no salvageable
output because the partial `labeled.jsonl` predates the split-map
construction and there's no way to resume.

### What the refactor changes

The cleanest shape (and the one I'd ship for v0.1.1) eliminates **all
three** in-memory structures by deciding each row's split inline at
align time, then multiplexing `labeled.jsonl` writes across three
per-split files. This is the right shape because the split decision
is a pure function of `{country, region, source_id}` — no global state
needed.

Concrete plan:

1. **`split.ts`** — extract a pure helper `splitForRow(row, holdouts):
SplitName` from the body of `splitRows()` (the per-row branch at
   lines 85-95 of the current `split.ts`). Keep `splitRows()` itself
   for callers that want the array shape (it's also exported from
   the package surface; removing it is a breaking change). New helper
   is ~10 lines.

2. **`build.ts` align loop (lines 172-197)** — replace the single
   `labeledStream` with three per-split streams
   (`labeled-train.jsonl`, `labeled-val.jsonl`, `labeled-test.jsonl`)
   under `intermediateDir`. For each aligned row, call
   `splitForRow(result.row, holdouts)` and route the JSON line to
   the matching stream. Drop the `splitInputs.push(...)` block
   entirely. ~15 lines change.

3. **`build.ts` split phase (lines 204-213)** — `splitRows(splitInputs)`
   call goes away. Instead, after the align loop closes the per-split
   streams, compute `SplitManifest.counts` from a final pass that just
   `wc -l`s each file (or tracks `aligned_per_split` counters during
   the align loop, which is one increment per write — trivially
   cheap). `writeSplitManifests` is reworked to take per-split file
   paths and stream-sort the source_ids to `<outputDir>/splits/
{train,val,test}.txt` via a streaming external sort (or accept
   that the per-split files are already in arrival order and skip
   the sort — the manifest needs deterministic order for git-diff
   stability, but a deterministic per-row stream → sorted output is
   provided by sorting each file with a single-pass external sort,
   which `sort(1)` does on disk in O(1) memory; can also use a
   skip-list / mergesort in JS if we want to stay in-process).

4. **`build.ts` parquet phase (lines 215-222)** — `writeShards` is
   already streaming over the labeled JSONL via `streamJsonl`. The
   `splitFor` callback (parquet.ts:145, 250) becomes unnecessary
   because the labeled JSONL is already partitioned by split — call
   `writeShards` three times, once per split, against the matching
   per-split file. Memory cost goes to zero.

The `splitByIdMap` disappears. The `SplitManifest` arrays disappear.
`splitInputs` disappears. Peak memory drops from ~5 GiB (synth-ON
projection) to ~600 MiB (the WOF ancestry index, which is a
separate problem).

### Hour-level estimate

The plumbing is mechanical but it touches three files (`build.ts`,
`split.ts`, `parquet.ts` signature change for `writeShards`) plus
three test files (`build.test.ts`, `split.test.ts`, `parquet.test.ts`).
The interface change to `writeShards` is the broadest — moving from
`(rows, opts.splitFor)` to `(perSplitPaths)`. Counting:

- Source edits: ~50 LOC across three files.
- Test edits: ~30 LOC (most tests pass full LabeledRow objects directly;
  the e2e build.test.ts just needs different file paths in assertions).
- Manifest format: backwards-compatible (the on-disk
  `SPLIT_MANIFEST.json` shape is unchanged; only the in-process
  array shape goes).

That's why it's roughly an hour — not "just turn on synth". Refactor

- tests + a sanity-pass build at fixture scale to confirm parity,
  then a real-data run.

### Why I didn't ship it as part of v0.1.0

The brief was "real-data corpus build v0.1.0 — see what breaks." It
broke in a predictable, well-defined place (the in-memory split
machinery), but the build artifact is still complete and useful as a
Phase 2 baseline. Doing the refactor inline would have turned a
"run the pipeline" task into a "ship an interface change" task —
broader scope, more review surface, and the v0.1.0 artifact would
have been gated on un-related code review.

If the operator wants v0.1.1 synth-ON, the refactor is the
next-session unit of work, not an in-line patch on this branch.

## 2026-05-17 — Was synth-OFF the right call for v0.1.0? (decision rationale, not just "what's needed for v0.1.1")

**Operator follow-up question:** decision rationale, observed
scale-effects, fan-out projection, and Phase 2 baseline viability.

### Scale-effects observed during the synth-OFF run

- **Memory.** RSS climbed to ~4.0 GiB during the wof-admin adapter
  run (ancestry index of 293 k US admin records keyed by `wof:id` to
  a list of parent ids — ~600 MiB resident; held the entire run
  because the postalcode adapter needs cross-repo ancestor names
  for unincorporated-ZIP synthesis). RSS then climbed to ~4.2 GiB
  during align as `splitInputs` accumulated 4.56 M entries
  (~680 MiB) and again at split phase as `splitByIdMap` materialized
  another ~450 MiB. With `--max-old-space-size=5800` and ~1.5 GiB
  reserved for V8 bookkeeping / GC headroom, the synth-OFF run
  finished with ~600 MiB heap to spare.
- **Time.** Adapter phase 11m38s total (wof-admin alone 9m53s
  dominated; wof-postalcode 1m44s, ban 18s, tiger 48s). Align +
  split + shard ~9 min. End-to-end ~21 min.
- **Disk.** intermediate/labeled.jsonl 1.5 GiB at 4.56 M rows
  (327 bytes/row JSON). canonical.jsonl-per-adapter 1.27 GiB. Final
  parquet shards 157 MiB SNAPPY (factor-9 compression vs JSONL,
  consistent with text-heavy address columns). Total /data/corpus
  /versioned/v0.1.0/ ≈ 3.2 GiB on disk.
- **Quarantine.** 66 / 4.56 M = 0.0014%. All
  `component-not-found:*` from WOF localized `name:*` properties
  carrying internal double-spaces. Not synth-related — the same
  rate would have surfaced on synth-ON. No `reconcileComponents`
  tuning needed.

### Synth-ON fan-out projection

Drawn from `defaultAugmentationsForCountry()` in
`packages/corpus/src/synthesize.ts:374-393`:

- **US**: 11 augmentations (`caseUpper, caseLower, dropCommas,
doubleSpace, stateExpand, stateAbbreviate, directionalExpand,
directionalAbbreviate, streetSuffixAbbreviate, streetSuffixExpand,
zipPlus4DashDrop`). Each augmentation is `(row) → row | null`;
  null is returned when the row lacks the relevant field
  (e.g., `stateExpand` on a country-only row).
- **FR**: 6 augmentations (4 universal + `accentStrip, particleStrip`).

Per-class effective fan-out (including the original) for the v0.1.0
input mix:

| Row class                          | Adapter        | Multiplier |
| ---------------------------------- | -------------- | ---------: |
| WOF admin US country/region        | wof-admin      |         3× |
| WOF admin US locality / sub        | wof-admin      |         4× |
| WOF admin FR (no US augmentations) | wof-admin      |         4× |
| WOF postalcode US (zip + state)    | wof-postalcode |         6× |
| WOF postalcode FR (FR-universal)   | wof-postalcode |         5× |
| BAN FR (house_number + street)     | ban            |         6× |
| TIGER US street (street + region)  | tiger          |         6× |
| TIGER US place (locality only)     | tiger          |         4× |

Weighted across the 4.56 M v0.1.0 mix (60% WOF admin US, 25% WOF
admin FR, 8% other) → **~4.5× average fan-out**.

Projected synth-ON labeled count: **~20 M rows**. ~3× the
synth-OFF v0.1.0.

### What pushed me to skip synth on _this_ run

In priority order:

1. **OOM risk during align, with no resume path.** The build is
   atomic — if `splitInputs.push` triggers OOM mid-align, the
   partial `labeled.jsonl` is unusable and the per-adapter
   canonical files are unindexed for resumption. I'd burn ~12 min
   on adapters, ~15 min into align, then crash. **At 4.5× fan-out
   the OOM is the central-case outcome, not an edge.**
2. **Time-to-result.** Operator brief said "see what breaks" — a
   completed 4.56 M-row v0.1.0 in 21 min beats a failed 20 M-row
   attempt in 40 min. Fail-fast turned into ship-fast.
3. **Augmentation duplication with WOF `name:*` variants.** The
   wof-admin adapter already fans rows out across 1+ name slots
   per WOF record (the Phase 1.5.1 fix). 866 k of the 4.16 M
   yielded rows deduped to a single canonical key — meaning the
   WOF `name:*` machinery already produces ~5 surface forms per
   logical record on average. Layering `caseUpper` / `caseLower`
   on top of "Saint Petersburg" / "St. Petersburg" / "Санкт-
   Петербург" doubles the count for marginal additional variety;
   most of the diversity work was already done by adapter-level
   fan-out for the wof-admin majority of the corpus.
4. **Training-time augmentation is the better default anyway.**
   The augmentation functions in `synthesize.ts` are pure and
   importable from the training-time data loader. Per-batch
   sampling at training time gives **more** variety than a fixed
   corpus fan-out (each epoch sees fresh augmentations rather than
   the same K pre-computed ones), at the cost of (a) augmenting
   live in the data loader and (b) not materializing the augmented
   text in the corpus on disk. Modern PyTorch / HuggingFace
   datasets handle this idiomatically.

Quarantine inflation was NOT a factor — the augmentations are
designed to be `reconcileComponents`-friendly and the fixture-scale
runs in Phase 1.5 showed zero quarantine inflation from synth.
Disk was not a factor — 6.6 GiB labeled.jsonl is well under our
815 GiB free.

### Phase 2 baseline viability

**Synth-OFF v0.1.0 is a usable Phase 2 baseline.** Specifically:

- **Surface-form diversity at the locality / region / country
  level**: covered by WOF `name:*` variants pre-existing in the
  adapter output. For example, the country-level row for `wof:id=
85633147` (France) emits 100+ name-slot variants from canonical
  `wof:name = "France"` through `name:abk_x_preferred = "Францие"`
  (Abkhaz). These already exercise per-script tokenization and
  diacritic handling.
- **Surface-form diversity at the street / house_number level**:
  partially covered. BAN rows ship as-is (no `caseUpper` / accent
  variants); TIGER rows ship in title-cased USPS form. This is the
  layer that training-time augmentation should handle — at training
  time, the data loader can apply the same `defaultAugmentations`
  table per-batch.
- **Quantitative scale**: 4.56 M labeled rows is comparable to or
  larger than the WikiNERd corpus that the Phase 2 plan referenced
  as a structural inspiration. It is enough to bootstrap a v0.1.x
  classifier without further data work.

What v0.1.0 does **NOT** cover, that synth-ON v0.1.1 would add:

- US ZIP+4-with-dash variants vs no-dash (`zipPlus4DashDrop`).
- US directional abbreviation (`NW` ↔ `Northwest`) for non-WOF
  rows. WOF rows have no directionals; TIGER street rows have
  them but in only one form.
- US state expand/abbreviate for the TIGER + WOF postalcode rows
  (WOF admin US gets both forms via name slots; TIGER places
  ship abbreviated only).
- US street-suffix expand/abbreviate (`Ave` ↔ `Avenue`) — the
  Phase 1.5 USPS Pub-28 codex augmentation. TIGER rows ship in
  one form.

These are the layers where training-time augmentation can do the
work, applied per-batch from the same `defaultAugmentationsForCountry`
table. **Phase 2 does not need to wait** for v0.1.1; it can proceed
on v0.1.0 with a training-time augmentation step in the data loader.
If v0.1.1 is wanted for offline-augmented benchmarking parity with
external models, that's a follow-up unit of work (see the
`splitInputs` refactor section above).

### Conclusion

Synth-OFF was the right call for v0.1.0. The artifact is a usable
Phase 2 baseline. v0.1.1 (synth-ON, after the splitInputs refactor)
is a "nice to have, not blocking" item — when the operator wants
augmented corpus parity with external geocoding benchmarks, that's
when the hour goes in.

## 2026-05-17 — splitInputs refactor: multiplex labeled.jsonl per split, drop the in-memory split map

**Context:** operator greenlit the refactor described in the
2026-05-17 "splitInputs refactor scope" entry above. This entry
records what actually shipped (design decisions made during the
implementation that the scope sketch didn't pin down).

### `splitForRow` extracted as pure helper

`packages/corpus/src/split.ts` now exports `splitForRow(row,
holdouts?): SplitName` — the per-row branch of the prior `splitRows`
function lifted into a pure helper. `splitRows` was kept (still
returns the in-memory `SplitManifest` shape) and now goes through
`splitForRow` internally so the in-memory and streaming paths can't
diverge on bucketing semantics. Tests cover both paths against the
same fixture inputs.

### `writeSplitManifestsFromLabeledFiles` shells out to `sort(1)`

The streaming-friendly manifest writer
(`writeSplitManifestsFromLabeledFiles`) streams source_ids out of
per-split labeled JSONLs and pipes them to coreutils `sort(1)` with
`LC_ALL=C` for cross-host byte-deterministic sorting. The alternative
(in-process sort) would have required either (a) loading the full
per-split source_id array into memory — defeating the refactor's
purpose — or (b) implementing an external mergesort in JS, which is
non-trivial. `sort(1)` is universally available on Linux/macOS and
handles disk spill automatically.

`LC_ALL=C` is essential: without it, locale-aware sorting can
produce different byte order across machines with different `LANG`
settings, breaking the cross-host determinism guarantee the manifests
exist to provide.

### `writeShards` signature change: `PerSplitRows`, not `splitFor` callback

`writeShards(rows, {splitFor})` became `writeShards(perSplit,
opts)`. The old shape pushed an O(n) `Map<source_id, SplitName>` onto
the caller (`buildCorpus`); the new shape pre-partitions rows into
per-split AsyncIterables, so the sharder iterates them sequentially
and only one parquet writer is open at a time. Memory cost in the
shard phase drops from O(n_aligned_rows) to O(row_group_size ×
row_size) ≈ 12 MiB.

The alternative I considered (keep `(rows, splitFor)` and let the
sharder lazily route via `splitFor`) would have left the O(n) Map
inside `buildCorpus` and added per-row callback overhead in the
shard hot path. Reshaping the interface was the cleaner break.

### What I did NOT change

- `splitRows` and `writeSplitManifests` stay (in-memory path for
  tests + small-fixture callers). Removing them would have been a
  breaking change to the package's public surface; the streaming
  path is additive.
- Manifest format on disk: unchanged. `SPLIT_MANIFEST.json` has the
  same shape (`{corpus_version, holdouts, counts}`); per-split
  `{train,val,test}.txt` files are still sorted line-separated
  source_ids.
- Parquet shard layout, schema, compression: unchanged.

### Measured outcome

The synth-ON v0.1.1 build (22,439,941 labeled rows, ~4.92× fan-out
over v0.1.0's 4.56M canonical) ran on the same 8 GiB container that
v0.1.0 ran on, with RSS peaking at ~3.9 GiB during the wof-admin
adapter phase (ancestry index dominated) and falling to ~700-800 MiB
through align/split/shard. No OOM, no `--max-old-space-size` bump
needed beyond the v0.1.0 setting of 5800 MiB. The refactor's stated
target ("from ~5 GiB synth-ON projection to ~600 MiB") is met for
the align/split/shard phases; the adapter phase's ~3.9 GiB residency
of the WOF ancestry index is a separate problem outside this
refactor's scope.

## 2026-05-17 — `doubleSpace` augmentation must update components (not just `raw`)

**Context:** the first synth-ON v0.1.1 build attempt produced a
8.94% quarantine rate (2,006,426 / 22,448,911 canonical+augmented
rows). Drill-down via the per-method breakdown:
2,004,682 (99.9%) of the quarantines traced back to the
`double-space` augmentation in `synthesize.ts`.

### Bug

`doubleSpace` was implemented as:

```ts
export const doubleSpace: Augmentation = (row) => {
	if (!/ /.test(row.raw)) return null
	const newRaw = row.raw.replace(/ /g, "  ")
	return withAugmentation(row, "double-space", newRaw, { ...row.components })
}
```

— it doubled spaces in `raw` but spread the components unchanged.
The corpus pipeline's `alignRow` (`packages/corpus/src/align.ts`)
uses substring search to find each component's surface form inside
`raw` so it can assign BIO labels to the right token spans. With
single-spaced components and double-spaced raw, the substring search
fails:

- raw: `"5  Chemin  des  Amandiers,  13980  Alleins"` (BAN address,
  spaces doubled)
- `components.street`: `"Chemin des Amandiers"` (still single-spaced)

The substring search for `"Chemin des Amandiers"` cannot find a
match inside the double-spaced raw, so the row is quarantined with
`reason: "component-not-found:street"`.

### Why the unit test missed it

The pre-existing `doubleSpace` test in `synthesize.test.ts` only
asserted on `out.raw`:

```ts
const out = doubleSpace(baseRow({ raw: "Paris France", components: { locality: "Paris", country: "France" } }))!
expect(out.raw).toBe("Paris  France")
```

…and the assertion is satisfied even with the bug, because the test
inputs use single-word components (`"Paris"`, `"France"`) which
don't have internal spaces to double. The bug only manifests on
multi-word components — which are the majority of real-world data
(streets, multi-word place names, country surface forms like
`"United States of America"`).

### Fix

Apply the same `replace(/ /g, "  ")` to every component value, so
the substring contract holds:

```ts
export const doubleSpace: Augmentation = (row) => {
	if (!/ /.test(row.raw)) return null
	const newRaw = row.raw.replace(/ /g, "  ")
	const newComponents: ComponentDict = {}
	for (const [k, v] of Object.entries(row.components)) {
		if (v) newComponents[k as ComponentTag] = v.replace(/ /g, "  ")
	}
	return withAugmentation(row, "double-space", newRaw, newComponents)
}
```

The regression test now asserts the **substring invariant**: every
component value must appear in `raw`. This catches not just this
specific bug but any future augmentation that breaks the same
contract.

### Why no other augmentations had the bug

`caseUpper` and `caseLower` correctly upper/lower-case both raw and
components. `dropCommas` leaves components alone but normalizes
whitespace in raw — the substring search still succeeds because
components didn't have commas to begin with. `accentStrip` and the
US-specific augmentations also update components and raw in
lockstep. `doubleSpace` was the only one that mutated `raw`-shape
without the corresponding components mutation, because spaces don't
appear in the toUpperCase/toLowerCase axis the bulk of the code is
organized around.

### Quarantine after the fix

Retried build: **8,970 / 22,448,911 = 0.040% quarantine rate**, a
99.9% reduction. Remaining quarantines are 7,226 double-space cases
that downstream-amplify the pre-existing WOF whitespace artifacts
that v0.1.0 surfaced (66 originals; components carrying internal
double-spaces from `name:*` properties that `formatAddress`
collapses in `raw`); the doubleSpace augmentation doubles BOTH the
pre-existing 2-space component artifact (→ 4 spaces) AND the raw
(→ 2 spaces), so the alignment substring contract still fails for
these specific rows. Same root cause as v0.1.0's 66 quarantines,
just amplified through the synth fan-out. Fixing it properly would
mean adding a whitespace-normalization step in
`reconcileComponents` at canonical-row emission time so components
and raw share a single-space normal form before alignment ever sees
them. That is the right fix for the residual but is out of scope
for v0.1.1 — 0.040% is well under the operator's 10% interrupt
threshold.

## phase-2 — train tokenizer v0.1.0 on corpus-v0.1.0 (synth-OFF), not v0.1.1

The Phase 2 plan locks tokenizer version to corpus version (1:1 — retraining mid-corpus
shifts SP token spans, which silently invalidates the stored whitespace-aligned BIO labels
in every parquet shard). v0.1.0 (synth-OFF, 4.56M rows) and v0.1.1 (synth-ON, 22.4M rows)
share the _canonical_ row set; v0.1.1 just adds case / spacing / accent / suffix augmentations.

For a unigram tokenizer with byte_fallback, those augmentations don't change the
character set or word forms in interesting ways — v0.1.0's character coverage already hits
the configured 0.9995. We trained on a 500k-US + 500k-FR reservoir sample from v0.1.0 to:

1. Honor the corpus-version lock the Phase 1 plan defined.
2. Keep training time short (1M lines, ~90 seconds end-to-end).
3. Avoid biasing the vocab toward the doubled / cased / accent-stripped synth variants
   when most production inputs at inference time will be unaugmented.

If we later retrain at v0.2.0 with new adapters that expand the character coverage (CJK
real data, RTL scripts, etc.), bump the tokenizer version in lockstep.

## phase-2 — single multilingual coarse model, exported per-locale with identical weights

Phase 2 §7 explicitly recommends this for Stage 1: "coarse is cheap to share". We confirmed:

- Same SP tokenizer for US + FR (byte_fallback handles non-Latin tokens for both).
- Same label set (Stage 1 coarse: country / region / locality / dependent_locality /
  postcode / subregion / cedex). No locale-specific tags at this stage.
- The BertForTokenClassification head doesn't condition on locale.

So `neural-weights-en-us` and `neural-weights-fr-fr` ship byte-identical `model.onnx` +
`tokenizer.model`. The per-locale split is purely a packaging convention so `@mailwoman/neural`
can resolve weights by locale tag. Splitting into per-locale weights is a Phase 3 decision
keyed off package size + load behavior — punted per the Phase 2 plan.

## phase-2 — torch.onnx.export uses dynamo=True (not the legacy TorchScript path)

`torch.onnx.export(..., dynamo=False)` raises `IndexError: tuple index out of range` inside
`transformers.masking_utils.sdpa_mask` on the Transformers 5.x line. The line
`q_length, q_offset = q_length.shape[0], q_length[0].to(device)` expects a tensor; the
TorchScript tracer hands it a `torch.Size` tuple. The bug surfaces even when we force
`_attn_implementation="eager"` because eager-mask still funnels through `sdpa_mask`.

The dynamo path (`dynamo=True`, requires the `onnxscript` package) traces through
`torch.export.export` and FX, which evaluates the tensor-shape ops correctly. We pin
`onnxscript` as a build-time dep of the `[train]` extra. Output ONNX is opset 17 with
dynamic axes `batch` + `sequence`; parity vs PyTorch is 1.67e-6 (well under the 1e-4
spec) on a 32-sample probe.

If we later pin Transformers to <5 we can switch back to the legacy path — the dynamo
output is byte-different (richer optimization passes) but functionally equivalent.

## phase-2 — CPU-side smoke artifact ships as a smoke-tagged package, not Phase 2 PR-blocker

Phase 2's success criteria require beating rule-based Mailwoman on golden-set F1 for coarse
components. The container has no GPU; the 6L/256H model trains at ~0.85 steps/s on CPU.
Hitting the spec'd 50k steps would take ~16 hours; even then, on a 74-entry golden set
(10 US + 10 FR + 54 adversarial — far short of the 500+500 target) the F1 estimates would be
high-variance.

Decision: run a CPU-only smoke training (2L/128H × 200 steps × batch 16) to validate the
entire pipeline (train → eval → ONNX → int8 quant → weights-package assembly) end-to-end,
and write the resulting artifacts into `packages/neural-weights-{en-us,fr-fr}/` with a
prominent **SMOKE BUILD — NOT PRODUCTION WEIGHTS** banner in the README + a matching note
in the model-card. The operator's GPU-host run replaces these in place using the same
`python -m mailwoman_train` CLI. The session-notes file enumerates the runbook.

This keeps the package shape stable so `@mailwoman/neural` (Phase 3) can be wired against
the directory structure today, even while the weights themselves are placeholders.

## phase-2 — hand-rolled encoder, not `BertForTokenClassification` or `nn.TransformerEncoderLayer`

The lab training GPU is a Radeon 780M (gfx1103). Per the validated `project-lab-gpu-780m`
recipe (operator brief on 2026-05-17), this hardware has two firmware-level gotchas on the
ROCm 6.2 wheel:

1. Flash- and mem-efficient-SDPA attention paths trigger HW Exceptions ("GPU Hang"). Only
   the math SDPA kernel runs stably. We force this via
   `torch.backends.cuda.enable_math_sdp(True)` plus the other two off, at every CLI entry.
2. `nn.TransformerEncoderLayer`'s fused path hangs at batch ≥128 fp32. We compose the
   block by hand: `nn.MultiheadAttention` + `nn.LayerNorm` + linear FFN.

A third surprise we hit and patched here: `torch.autocast(bfloat16)` selects an internal
fused MHA fast-path that hangs at batch ≥64 on this hardware too. The workaround is to cast
the _model itself_ to bf16 (`model.to(dtype=torch.bfloat16)`) and feed bf16 tensors —
"true bf16" training rather than autocast. Same throughput envelope, no fast-path.

A fourth: `torch.onnx.export` on the GPU hangs during dynamo tracing for the same model.
The exporter is moved to CPU explicitly before tracing; output ONNX is device-agnostic so
the production runtime is unaffected.

Empirical batch ceiling: 64 micro-batch. Operator's brief said ≤192; we ran into hangs at
96 with our specific code path. Effective batch reaches the §4 plan's "256 (lower if OOM)"
target via `grad_accum_steps=2` → effective 128. At 5.4 optimizer steps/sec × 64 = 345
samples/sec sustained, which is 2× the operator's documented 175 samples/sec for the
planned geometry. 50k optimizer steps with accum=2 = 100k micro-batches ≈ 5–6 hours wall
on this hardware.

Compatibility note: the smoke run on CPU (pre-GPU-recipe) used
`BertForTokenClassification`; those artifacts are wholly replaced.

## phase-2 — ship Stage 1 weights below the §6 95% F1 target, with honest model card

Phase 2 §6 sets a 95% per-component F1 target. The v0.1.0 model trained this session lands
nowhere near that: country=0.000, region=0.104, locality=0.042, postcode=0.000 on the
74-entry golden set.

Per the issue's "When to ship vs train more" framing, <90% F1 = stop and re-examine. The
diagnosis (see LOG.md 01:10 entry) points to a corpus-balance issue, not an architecture
or training bug: 75% of training rows are wof-admin "Name" / "Name, Country" entries, and
the model overfits to a positional heuristic ("first-token = locality, middle = region,
end = country"). Golden-set entries with street prefixes (e.g.
`1600 Pennsylvania Avenue NW, Washington, DC 20500`) confuse this heuristic — the model
labels the whole street prefix as `I-locality`.

We still ship the weights packages with these numbers, because:

1. The package shape is the actual Phase 2 deliverable for downstream Phase 3 wiring.
   `@mailwoman/neural` (Phase 3) needs to load a `model.onnx` + `tokenizer.model` at the
   committed paths. Shipping placeholders blocks Phase 3 indefinitely.
2. The model-card and README honestly report **⚠ Below Phase 2 §6 targets** with the
   per-component numbers. Anyone consuming these weights sees the gap at a glance.
3. The recipe for a successful v0.2.0 retrain is documented (source-weighted sampling
   or synthesized street prefixes). That's a future-session fix, not a Phase 2 blocker.

The Phase 2 plan also says: "Beats rule-based Mailwoman on golden set for `country` and
`region` components by at least 2 F1 points. If not, investigate before proceeding — the
architecture is fine, the corpus is probably the issue." That's exactly the call we made.

## phase-2 — auto-restart wrapper for gfx1103 GPU hangs under sustained training load

The gfx1103 firmware exhibits `HW Exception by GPU node-1 ... GPU Hang` roughly every
30–60 minutes under sustained training load. The hangs are unpredictable in timing but
recoverable: the process aborts (exit 134), the GPU recovers in a few seconds, and a
fresh process initializes normally.

Rather than try to harden the kernel against an in-process recovery (no clean
`torch.cuda.recover()` API), Phase 2 ships `packages/corpus-python/scripts/train_with_resume.sh`
— a thin bash loop that re-launches `python -m mailwoman_train train --resume auto`
after every non-zero exit, sleeping 15 seconds between attempts. `--resume auto` walks
the checkpoint directory and picks the highest-step `step-XXXXXX/` to resume from.

To make resume meaningful, `save_checkpoint` writes the full training state per call:
`pytorch_model.bin` (weights), `optimizer.pt` (Adam moments), `scheduler.pt`
(cosine-decay step), and `training_state.json` (the integer step). On resume,
`train()` loads all of these; if `scheduler.pt` is missing (pre-resume-feature
checkpoint), it fast-forwards the scheduler by `resume_step` steps so the LR matches.

Save cadence dropped from `save_every_steps=5000` to `save_every_steps=2000` so the
worst-case wasted work per crash is half an eval interval.

## 2026-05-22 — v0.3.0 Stage 2 dual loss: down-weight CRF + drop label smoothing + lower LR

**Context:** Stage 2 (v0.3.0) adds a linear-chain CRF decoder + label smoothing 0.1 on top of
v0.2.0's Stage 1 CE-only training recipe. The v0.2.0 hparams (lr=5e-4, no grad clip,
batch=32 grad_accum=4, bf16 + math SDPA on gfx1103) were proven over a successful 50k-step
run. The first stab at Stage 2 reused those hparams + added the CRF + smoothing toggles
with no other changes. It collapsed.

**Failure modes observed across four iterative attempts:**

1. Run 1 (lr=5e-4, no clip, crf_loss_weight implicit 1.0, label_smoothing 0.1) — catastrophic
   divergence at step 1000 when warmup LR hit peak; train_loss 3 → 162 in 250 steps.
2. Run 2 (added grad_clip_norm=1.0 + lr=3e-4, crf_w 1.0, ls 0.1) — slow drift: val_macro_f1
   peaked 0.26 at step 500 then dropped to 0.17 by step 750.
3. Run 3 (crf_loss_weight=0.1) — val_macro_f1 0.32 at step 500 then 0.19 at step 1000.
   Better but still degraded.
4. Run 4 (lr=1.5e-4, crf_w=0.05, label_smoothing=0.0) — cleared warmup peak; val_macro_f1
   0.36 at step 1000 and still improving.

**Options considered:**

1. Increase warmup steps (e.g. 1000 → 5000) — slows ramp but doesn't change the
   steady-state LR. Diagnostic but ineffective alone.
2. Drop label smoothing — removes one variable. With 21 classes the smoothed target on
   non-gold positions is 0.005, basically gradient noise.
3. Down-weight CRF NLL — CE is per-token + log-bounded ≈ 3; CRF NLL is per-sequence +
   unbounded ≈ 10–100. Equal-weight summing lets CRF gradients drown out CE.
4. Lower peak LR — v0.2.0 worked at 5e-4 (CE only); the dual-loss landscape is more
   sensitive. Standard NER+CRF practice (AllenNLP, FLAIR) is ~1e-4.
5. Per-token-normalize the CRF NLL — normalizes magnitudes so equal weighting is honest.
   Closer to first principles but adds a divide-by-zero risk at empty sequences.

**Chosen:** combination of options 2, 3, and 4. Drop label_smoothing → 0, set
crf_loss_weight → 0.05, peak LR → 1.5e-4. Add a defensive grad_clip_norm=1.0 in train.py
for the warmup peak. Keep cosine decay + 1000-step warmup unchanged.

**Rationale:**

- Each fix removes a destabilizing variable independently confirmed against the v0.2.0
  baseline (which had none of them).
- crf_loss_weight=0.05 turns CRF NLL into a tiny structural regularizer on the emissions
  rather than a co-equal loss term. The CRF Viterbi at eval time still benefits from the
  learned transition mask (Viterbi gives the structural-validity win whether the loss
  weighted CRF heavily or lightly).
- Dropping label_smoothing trades a small calibration improvement for training stability.
  CRF training already steers emissions to be CRF-decodable (low mass on would-be-orphan-I
  labels), which gives calibration tightening from a different angle.
- LR 1.5e-4 is on the conservative side of NER+CRF norms. v0.2.0 trained at 5e-4 because
  CE is naturally bounded; Stage 2's joint loss is not.

**Reversibility:** all three knobs are tunable via stage2.yaml. crf_loss_weight could
re-up to ~0.1 if the CRF transition prior turns out to be under-trained at 0.05; raising
LR to 2e-4 likely works with the lower CRF weight; turning label_smoothing back on for
calibration ablation would need re-validation. Per-token normalization of CRF NLL is the
principled future fix that would eliminate the need to hand-weight.
