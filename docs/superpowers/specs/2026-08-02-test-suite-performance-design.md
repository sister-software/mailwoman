# Test suite performance — design

**Date:** 2026-08-02
**Status:** design approved; e2 spike run and CLOSED NEGATIVE; plan not yet written
**Optimizing for:** PR wall-clock (time to green). Machine-cost, local dev loop, and split
durability are secondary and only picked up where they ride along free.
**Deliverable:** PR wall-clock 6m29s → ~2m00–2m15s (projected from measured per-step numbers), and
an evidence-lexicons gate that stops growing with the gazetteer.
**Sibling:** `2026-08-02-pnpm-migration-design.md` — approved separately, gates only step (e1).

## The question

`test.yml` takes 6m29s on a green run and the operator's prediction is that it gets worse as the
gazetteer expands. Both halves needed measuring before designing: where the time actually goes, and
which of it scales with the data.

## What was measured before designing

All numbers below are from probes run 2026-08-02 — CI run `30757682542` (main, all legs green) via
the Actions API, and local runs on the lab host (16 cores, 29 GB, load ~4). Estimates are labelled
as such; everything else is measured.

### Finding 1 — the CI budget

| leg       | where            |  install |  compile |           leg-specific |     test |     total |
| --------- | ---------------- | -------: | -------: | ---------------------: | -------: | --------: |
| static    | hosted           |      74s |      29s | typechecks 39s, uv 10s | lint 15s |      185s |
| unit-fast | hosted           |      83s |      35s |                      — |      10s |      143s |
| react     | hosted           |      80s |      36s |         playwright 22s |      13s |      161s |
| unit-slow | `mailwoman-data` |      16s |      36s |    weights restore 48s |     253s |  **368s** |
| smoke     | `mailwoman-data` |      18s |      35s |    weights restore 54s |      67s |      192s |
| **Σ**     |                  | **271s** | **171s** |                   173s |     358s | **1049s** |

Wall-clock is `unit-slow` plus queueing. Install + compile is 442s — 42% of all machine-time — and
it is the same build performed five times on the same commit.

### Finding 2 — one test file is the entire critical path

Local slow-leg run: 87 files, 651s of summed file-duration, 240s wall.

| file                                                     |   duration | tests |
| -------------------------------------------------------- | ---------: | ----: |
| `mailwoman/gazetteer-pipeline/evidence-lexicons.test.ts` | **236.9s** |    14 |
| `neural/test/weights.test.ts`                            |      96.6s |    14 |
| `mailwoman/commands/geocode.test.ts`                     |      34.6s |     7 |
| `resolver-wof-sqlite/candidate-lookup.test.ts`           |      30.6s |    24 |
| `mailwoman/test/pipeline-debug-cli.test.ts`              |      30.0s |     4 |

`evidence-lexicons` is 93% of the leg's test time in two tests — 125.9s (FR) and 110.8s (US). Both
call `buildLocalitySurfaceLexicon`, which runs `computeSurfaceCountryCounts(dbPath)` (a full-DB
scan), a whole `place_population` iterate, and an `ancestors` join, from scratch, per call. This is
the file that scales with the gazetteer.

Measured control: the same leg with that one file excluded runs in **89s** instead of 240s.

### Finding 3 — the Actions cache is over quota and thrashing

```
active_caches_size_in_bytes: 10,715,161,750     ← 10.7 GB against a 10 GB repo limit
active_caches_count: 78
```

| key prefix                       |    size |                    entries |
| -------------------------------- | ------: | -------------------------: |
| `codeql-overlay-base-database-*` | 4324 MB |                         54 |
| `node-cache-*` (setup-node yarn) | 3024 MB |        4 (612 MB × 4 refs) |
| `weights-*`                      | 2870 MB | 17, across 9 distinct keys |
| `setup-uv-*`                     |    2 MB |                          3 |

Over quota, GitHub evicts LRU, so the yarn cache is present on some runs and gone on others. Same
branch, same day:

| run         | time  |   Fetch step | install total |
| ----------- | ----- | -----------: | ------------: |
| 30748817949 | 12:55 |   0.6s (HIT) |          ~24s |
| 30756381558 | 16:20 | 56.4s (MISS) |          ~78s |
| 30757682542 | 16:54 | 61.0s (MISS) |          ~83s |

The 16:54 run's Setup Node log says `yarn cache is not found` outright. That is a ~59s coin-flip on
each of three hosted legs. Nothing about the yarn configuration is wrong — there is no room.

Note the Link step is a flat **20.7–22.7s regardless** of cache state: yarn writing 74,244 files and
10,444 directories.

### Finding 4 — the weights cache moves 76 MB over the wrong wire

The `weights-*` cache payload is **76.3 MB** of real files (the rest of the glob resolves to
symlinks). Restoring it takes 48–54s on the two `mailwoman-data` legs ≈ **1.6 MB/s** — the lab's
documented-degraded path to GitHub's cache service.

Meanwhile `release.config.json` points the source model at
`/mnt/playpen/mailwoman-data/models/quantized/model-v3230-guard-step-004000-int8.onnx` — local disk,
on the same host the leg runs on. Only the derived `postcode-*.bin` / `pair-index-*.bin` need
building, via `spawnSync` of `mailwoman gazetteer postcode-binary` and `gazetteer pair-index`. That
is the "~5 min" the cache exists to avoid, not the copy.

### Finding 5 — the runner

`vitest 4.1.10`, `forks` pool, `isolate: false` (already applied; the config docstring records the
8m23s → 1m30s win it bought).

Fast leg, 327 files, worker count swept:

|      workers |  wall | transform | import | tests | Σ CPU |
| -----------: | ----: | --------: | -----: | ----: | ----: |
|            4 | 9.85s |      5.57 |  10.45 | 27.16 |   43s |
|            8 | 6.92s |     10.75 |  20.48 | 30.95 |   62s |
| 16 (default) | 6.00s |     23.41 |  41.96 | 38.76 |  104s |
|           24 | 6.84s |     55.22 |  91.29 | 43.23 |  190s |

`isolate: false` amortizes the module graph **per fork**, not per run, so import + transform scale
linearly with fork count while wall stays flat. `import('@mailwoman/core')` under plain node is
0.15s; the same graph under Vite is ~2.6s per worker (42s ÷ 16 forks; 10.45s ÷ 4 forks — it divides
exactly). Relevant because four legs share the lab's 16 cores: `unit-slow` ran at 281% CPU.

`--pool=threads` measured 5.80s vs 6.00s — no win, and it would put `node:sqlite` and the ONNX
native addon in shared-process land. Not pursued.

### Finding 6 — vitest collects a Python virtualenv (local only)

The root config excludes `node_modules` but not `.venv`. In the main checkout vitest collects five
files from `corpus-python/.venv/lib/python3.12/site-packages/trackio/frontend/`, a vendored Svelte
app. At `--maxWorkers=4` one of them failed the run:

```
FAIL corpus-python/.venv/.../trackio/frontend/src/lib/legend.test.js
Error: No test suite found in file .../legend.test.js
```

Normally it is the unexplained `1 skipped`. **CI is unaffected** — `.venv` and `scratchpad/` are not
checked in, and a fresh worktree collects 316 files vs the main tree's 327. This is a local-dev and
agent-worktree flake, not a CI cost.

## Design

Six pieces. (e2) was spiked first at the operator's direction and is closed negative; its receipt is
kept here so it is not re-proposed.

### e2 — `nodeLinker: pnpm` — CLOSED NEGATIVE

Spiked in this worktree off `origin/main` (9b46c82e), warm global cache:

| metric         | control (`node-modules`) | `nodeLinker: pnpm` |         Δ |
| -------------- | -----------------------: | -----------------: | --------: |
| cold install   |                **41.6s** |              48.4s |     +6.8s |
| cold compile   |                **32.9s** |              40.5s |     +7.5s |
| `ci:test:fast` |                    7.48s |              7.22s |      wash |
| node_modules   |           74,244f / 2.5G |     69,502f / 2.3G | −6% files |
| test result    |                 316 pass |         **7 FAIL** |         — |

It loses on both metrics it was meant to win. Yarn's global cache already makes Fetch 0.4s, so Link
is the whole cost, and yarn's pnpm linker still materializes a real `.store` plus 7,719 symlinks
rather than hardlinking a machine-wide store. It also warns that the pnpm linker cannot provide
different peer-dependency versions to workspaces, which is a live constraint at 41 workspaces.

The 7 failures are a separate latent bug worth fixing regardless: `vitest.config.ts:82` hardcodes
`resolve(here, "node_modules/onnxruntime-web/dist/ort.node.min.mjs")` instead of resolving the
specifier, so it breaks under any layout change.

**This does not bear on migrating to pnpm the package manager**, which is a different mechanism —
its own resolver and lockfile, and a machine-wide content-addressed store with hardlinks rather than
a per-project `.store`. That migration is approved on ecosystem-direction grounds and has its own
spec: `2026-08-02-pnpm-migration-design.md`. It is **not** justified on speed (Fetch is already 0.4s
warm locally and 0.6s on a warm CI cache), and it sequences **before** (e1) here, because (e1) has to
be built against whatever layout wins.

A phantom-dependency scan run for that migration also corrects a risk this document originally
overstated. Predicted: strict resolution surfaces undeclared deps across 41 workspaces, a long tail.
Actual, full scan (`docs/` excluded — its `@theme/*` specifiers are build-time aliases):

| package            | workspaces importing it undeclared |
| ------------------ | ---------------------------------: |
| `vitest`           |                                 38 |
| `typescript`       |                    1 (`mailwoman`) |
| `@duckdb/node-api` |                       1 (`corpus`) |

Three packages, mechanically fixable. Every other root devDep is already declared where it is used.

### e1 — cache `node_modules` directly (hosted legs only)

**Depends on the pnpm migration landing first** (`2026-08-02-pnpm-migration-design.md`). Under pnpm
the natural form of this step is caching the **store** and running `pnpm install --offline`, which
should beat the yarn numbers below because the store is content-addressed and install is hardlinks
rather than copies. The yarn measurements stand as the control the pnpm form has to beat.

Drop `cache: yarn` from `setup-node` on `static`, `unit-fast`, `react`. Replace with `actions/cache`
on `node_modules`, key = runner OS + Node version + `yarn.lock` + `.yarnrc.yml` + every workspace
`package.json`, plus `restore-keys` so PR branches read main's entry (and therefore do not each save
their own 612 MB copy — that alone is the 3024 MB line in Finding 3).

Measured: the archive is **736 MB** and extracts in **3.59s** for 74,226 files. On a hosted runner
that is roughly 3–8s download plus 3.6s extract ≈ **10s, deterministic**, replacing the 24s-warm /
83s-cold coin-flip. It removes both Fetch and Link in one move.

**Hosted only.** At the lab's measured 1.6 MB/s to the cache service (Finding 4), a 736 MB restore
would take ~7 minutes there. The two `mailwoman-data` legs keep `yarn install --immutable` against
the local global cache, which is already 16s.

Risk: a `node_modules` cache carries built native artifacts. The key must include runner OS and Node
version. `ONNXRUNTIME_NODE_INSTALL: skip` is already set repo-wide, and Playwright browsers live
outside `node_modules` (`~/.cache/ms-playwright`), so neither is captured.

### a — cache quota

A scheduled `cache-prune.yml` (`schedule` + `workflow_dispatch`, `permissions: actions: write`),
using `gh cache list --json` → `gh cache delete`:

| key prefix                       |          now | policy                                         |   after |
| -------------------------------- | -----------: | ---------------------------------------------- | ------: |
| `codeql-overlay-base-database-*` | 4324 MB / 54 | keep newest per language on the default branch | ~240 MB |
| `node-cache-*`                   |  3024 MB / 4 | retired by (e1)                                |       0 |
| `weights-*`                      | 2870 MB / 17 | retired by (b)                                 |       0 |

10.7 GB → ~1.9 GB, leaving room for (e1)'s 736 MB and (e3)'s archive. The prune skips anything
accessed within the last hour so it cannot race a live write.

**Decision taken:** keep newest CodeQL overlay-base per language rather than deleting all of them.
They are CodeQL's incremental-analysis cache; pruning to zero reclaims another ~240 MB and costs
CodeQL time on every run. Revisit only if quota gets tight again.

### b — weights from the data root, not GitHub's

Remove the `actions/cache` weights step from both `mailwoman-data` legs. `scripts/copy-weights.ts`
grows a derived-artifact store at `$MAILWOMAN_DATA_ROOT/derived/weights/<key>/`:

- `model.onnx` / `tokenizer.model` — already a copy from the data root. ~1s.
- `postcode-*.bin` / `pair-index-*.bin` — the expensive part. Built once per key, hard-linked in
  thereafter.
- Key = the inputs the workflow hashes today (`release.config.json`, `data/gazetteer/*.json`,
  `data/gazetteer/*.jsonl`, `mailwoman/gazetteer-pipeline/borough-pairs.ts`,
  `mailwoman/gazetteer-pipeline/lieudit-pairs.ts`, `mailwoman/commands/gazetteer/pair-index.tsx`)
  **plus the CLI command modules that generate the bins**. That last clause is the existing header's
  own lesson — a key that omits the code generating the cached thing is a stale-artifact machine —
  applied one level deeper than the workflow could reach.

48–54s → ~2s on the critical-path leg, and 2870 MB of quota returned. Self-hosted runners have a
persistent filesystem, so the store is durable across runs; this matches the repo's
sealed-immutable-artifact convention for the data root.

The path must stay correct when the derived store is cold: first run after a key change pays the
~5 min build once, exactly as a cache miss does today.

### c — evidence-lexicons, four layers

Four layers because there are four distinct failure classes and no single gate covers them.

| layer            | when                                                                                  | catches                                                                                |           cost |
| ---------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------: |
| fixture          | every PR                                                                              | law logic regressions                                                                  |          `<1s` |
| full, path-gated | PRs touching `mailwoman/gazetteer-pipeline/**`, `data/gazetteer/**`, the FST curation | builder code changes                                                                   | ~130s, own job |
| full, nightly    | `schedule`, on `mailwoman-data`                                                       | **data drift** — the gazetteer is rebuilt outside any PR, which no path filter can see |          ~130s |
| full, release    | `publish.yml` prepare                                                                 | final gate                                                                             |          ~130s |

The fixture follows the established `resolver-wof-sqlite/candidate-lookup.test.ts` idiom: a tiny
admin DB built with the production DDL, seeded rows, and the **real** `buildLocalitySurfaceLexicon`
driven through `opts.dbPath` (the parameter already exists). Seeds carry every flip row the current
assertions name — paris/lyon/rennes/joseph, washington/wyoming/vermont/missouri/north dakota,
east/west/north/south/northeast/southwest, east nashville, mount washington,
fargo/minot/rutland/plainfield/cheyenne — plus the `place_population` and `ancestors` rows that
drive the prominence and parent-inheritance math.

The scale assertions do not migrate; they get stronger. A seeded below-floor row lets the fixture
assert `skippedProminence === 1` where real data only supports `> 0`. `built.entries > 10_000` stays
a full-build assertion, because that is a claim about the gazetteer, not about the laws.

Memoize `computeSurfaceCountryCounts` and `loadPersonNameSurfaces` by `dbPath` + mtime so the FR and
US builds in one process share the scan: 237s → ~130s (estimate) wherever the full build runs.

**Decision taken:** when the path-gated full build does not run, `unit-slow`'s step summary must say
so, in the style of the existing PARTIAL GATE annotation. Otherwise the leg reports the same while
meaning less, which is the thing `test.yml`'s header explicitly refuses.

### d — `neural/test/weights.test.ts` session reuse

96.6s across 14 tests; five in the pair-prior block each pay a full
`loadFromWeights({locale: "en-gb"})` at 12–13s while varying only decode-time configuration
(`placetypePair`, `pairIndexPath`, `transitionBeta`), not the session. Hoist the session for those;
keep independent loads for the tests that are _about_ load behaviour — `resolveWeights` auto-resolve,
the tolerant-loader paths, the error cases.

The file contains no `vi.mock`, so the `isolate: false` reset contract documented in the root config
does not bind here.

Target **96.6s → ~45s** (estimate), not lower — some of those loads are the assertion.

### e3 — cache `out/` + `*.tsbuildinfo`

`out/` is 274 MB across 4104 files; `tsc -b` cold is 32.9s, and 13.0s with `out/` and the
`.tsbuildinfo` files present but `node_modules` freshly reinstalled (measured — that is the restore
scenario). So this is 33s → ~13s per leg, not → 0s: `tsc -b` still stats the project graph.

Key = a hash of workspace `.ts` sources plus the tsconfigs. Lands after (a) so there is quota for it.

### Free items

- Vitest excludes for `**/.venv/**` and `**/scratchpad/**` — fixes Finding 6. Local-only benefit.
- Cap workers on the lab legs. Two concurrent legs × 16 forks on 16 cores is part of why `unit-slow`
  sat at 281% CPU; on the fast leg, 8 workers cost ~0.9s wall and returned 40% of the CPU. **Measure
  before setting a number** — this must land after (c), because `unit-slow` today is dominated by a
  single file and capping workers there would be measuring the wrong thing. Once (c) lands the leg
  runs 87 files at 4.2× parallelism and the cap becomes meaningful.

The `vitest.config.ts:82` hardcoded `onnxruntime-web` path (surfaced by the e2 spike) moves to the
migration spec — it has to be fixed before the layout changes, not after.

## Sequencing

`e2` is done (negative). The pnpm migration is a **sibling project**, not a step here — it touches
the publish pipeline, which is orthogonal to test performance and is the most-scarred surface in the
repo. It gates only (e1).

Remaining order, most-certain-prize first:

1. **a** — cache prune. Config only; unblocks quota for e1/e3. No dependency on the migration.
2. **b** — weights from the data root. No dependency on the migration.
3. **c** — evidence-lexicons four-layer split. The only piece with real design content, the largest
   single wall-clock win, and the only one that stops the gazetteer making this worse over time. No
   dependency on the migration.
4. **d** — weights.test session reuse.
5. **e3** — `out/` cache.
6. **e1** — install caching. **After** `2026-08-02-pnpm-migration-design.md`.

Free items ride along with whichever step touches the same file — except the `vitest.config.ts:82`
`onnxruntime-web` fix, which moves into the migration spec (it must land before the layout changes,
not after).

Steps 1–5 are independent of the migration and can proceed in parallel with it, in a separate branch,
provided the two do not both edit `test.yml` at once.

Re-measure after (b) and again after (c). `static` becomes the critical path once `unit-slow` drops
below ~185s, so steps 5–6 should be re-justified against a fresh measurement rather than assumed.

## Acceptance criteria

- `test.yml` green wall-clock ≤ 3m00s on a no-op PR, measured over three consecutive runs (not one).
  Projection from the per-step numbers is ~2m00–2m15s **without** (e1); the criterion is set at 3m00s
  because job queueing and runner startup are not in that projection.
- Hosted-leg install ≤ 30s on all three legs across those same three runs — the point is that the
  coin-flip is gone, not that one run was fast. (e1) later tightens this to ≤ 15s.
- `active_caches_size_in_bytes` < 8 GB.
- `unit-slow` test step ≤ 120s on a PR that does not touch the gazetteer pipeline.
- The full-scale locality-surface build still runs, and still asserts `entries > 10_000`, in at least
  the nightly and release layers. A run that skips it says so in its step summary.
- `evidence-lexicons.test.ts` on the PR path is invariant to gazetteer size — re-running it after a
  gazetteer rebuild changes nothing.
- No net loss of assertions. Every law currently asserted is still asserted somewhere that runs on
  every PR.

## Non-goals

- Machine-cost reduction as an end in itself. It falls out of (a)/(e1)/(e3) but is not what this is
  optimizing.
- Replacing vitest. Finding 5 shows the Vite transform pipeline costs ~17× plain node for the same
  graph, but changing runners is a different project with a different risk profile.
- The pnpm migration. Approved, but its own project with its own driver (ecosystem direction, not
  speed) — `2026-08-02-pnpm-migration-design.md`. It gates only (e1).
- Making the fast/slow split declarative (vitest projects instead of the hand-maintained exclude list
  in `package.json`). Worth doing, does not serve wall-clock, deliberately deferred.

## Risks

- **(e1) stale native artifacts.** A `node_modules` cache can serve binaries built for a different
  runner image. Mitigated by keying on runner OS + Node version; if a third-party postinstall starts
  depending on something else, this is where it bites.
- **(b) stale derived bins.** The existing weights-cache key already shipped this bug once
  (2026-08-02: the currency-filter change produced new artifacts while the cache served old ones,
  and the pair-index↔card parity guard failed with `expected 47878 to be 49033`). The derived-store
  key must include the generating CLI modules, and the parity guard stays as the backstop.
- **(c) fixture drift.** A fixture that stops representing the real data is a gate that passes while
  meaning nothing. The nightly full build is the control for exactly this; if it is disabled, the
  fixture layer alone is not sufficient.
- **(a) pruning something live.** The prune skips caches accessed within the last hour, and deletes
  nothing whose key prefix is unrecognized.
