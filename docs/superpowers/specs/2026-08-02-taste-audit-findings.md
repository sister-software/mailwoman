# Repo-wide taste audit — findings

**Date:** 2026-08-02
**Base:** `origin/main` @ `9b46c82e`
**Scope + method:** [`2026-08-02-taste-audit-design.md`](./2026-08-02-taste-audit-design.md)
**Execution status:** sixteen of twenty-three clusters landed — see below.

## Status — 2026-08-02, after execution

Sixteen of the twenty-three clusters landed on `worktree-taste-audit` across 21 commits. Every one
was verified against a recorded baseline (4,617 passing tests before any edit) with `yarn compile`,
`yarn lint` and the affected test slices green per commit.

| cluster   | what landed                                                                 |
| --------- | --------------------------------------------------------------------------- |
| A2        | five percentile copies → `core/utils/stats.ts`; two kept, annotated         |
| A3        | `mulberry32` / `makeLcg` thunks → `core/utils/python-random.ts`, 16 sites   |
| A4        | `check-release-parity` → `APIClient`; file transfers classified + annotated |
| A5 / A6   | hashing and JSONL callers repointed; four kept raw, annotated               |
| A7        | data-root literal back to one place; one real behavioural default fixed     |
| A8        | `jaccard` → `match/comparators.ts`                                          |
| B1        | ray cast → `spatial/geometries/polygon.ts` (corrected — see below)          |
| B2        | ten-copy regex + splitter → `corpus/src/adapter.ts`                         |
| B3 / B4   | python numerics → `core/utils/python-numeric.ts`; `splitCSV` → scaffold     |
| B5        | `swapDatabaseIntoPlace` → `core/utils/sealed-db.ts`                         |
| B6        | duplicated `v0-tree-adapter.ts` deleted                                     |
| B8 / B9   | `foldName` + `wordNorm` → `codex/normalize.ts`                              |
| B10 / B13 | route plumbing → `api-kit`; `tiger/sdk/download.ts` extracted               |
| B11       | `registry/tools/shared.ts` created for 24 script-strong directory           |
| C1        | `scripts/lint-acronym-casing.ts` wired into `yarn lint`; 11 renames         |

**Measured effect:** cross-file clone groups 83 → 54. The remainder is mostly A1's weights family
and B14's test fixtures.

### Still open

- **A1** — the nine `link-dev-weights.ts`. Blocked on a decision only the operator can make (below).
- **B7** — the docs↔react component forks. Needs a call on whether react's components take a
  className/theme prop so Docusaurus styling survives; that is a design decision, not a dedupe.
- **B12, B14** — byte formatters and test-fixture builders. Real, cheap, lowest payoff; left for
  whoever is next in those files.

### Four findings this audit got wrong, corrected by implementing them

1. **The great-circle cluster** (7 candidates) → **0 findings**. Five were importers, one a
   documented adapter, one a deliberate variant for a different quantity.
2. **B1** said move all three point-in-polygon copies to `@mailwoman/spatial`. `nuts-lookup` and
   `timezone-lookup` each carry ONE dependency (zero-dep `@mailwoman/annotations`); spatial pulls
   `@mailwoman/core` and its ~11 MB of shipped data. Three orders of magnitude for fifteen lines.
   One moved, two documented in place.
3. **A1** called nine files nine forks with a "4.3× size spread = divergence". Reading their
   `package.json` files: two are BASE packages, seven declare `mailwoman.baseWeights` and are
   OVERLAYS. The spread is mostly the difference between those roles.
4. **A4** counted 28 raw-`fetch` sites as one population. They are two: ~23 API requests (migrate)
   and 4–5 multi-gigabyte file transfers streamed to disk (do not — response caching is nonsense at
   that size and axios buffers any non-stream response type in memory).

Every one of those corrections came from opening a `package.json` or a dependency graph that the
grep-plus-read pass never did.

## Summary

| axis                      | clusters | sites | notes                                                     |
| ------------------------- | -------: | ----: | --------------------------------------------------------- |
| A — home exists, bypassed |        8 |   ~95 | the owning module is already written and already imported |
| B — orphan duplication    |       14 |  ~110 | no home yet; each cluster below names one                 |
| C — idiom drift           |        1 |   ~30 | acronym casing only; the other four conventions hold      |
| D — altitude              |        1 |     1 | observation, not a verdict                                |
| rejected on reading       |       10 |   ~20 | see the appendix — do not re-propose these                |

**Shortlist — do these first.** A1 (nine forked `link-dev-weights.ts`, already diverged, already
shipped consequences), B2 (ten byte-identical copies of the same regex + splitter, the cheapest fix
in the audit), B1 (three point-in-polygon implementations in three published packages), B6 (a whole
file duplicated with a written exit plan nobody executed).

**The pattern underneath most of this.** Three of the largest clusters are not "nobody wrote a
home" — they are "the home exists, and the call site could not use it as shaped." A3 is the clearest:
`SeededRandom` in `core/utils/python-random.ts` is mulberry32 by its own docstring, but it is a class
with a `.random()` method, and all sixteen call sites want a `() => number` thunk. So sixteen sites
rebuilt the generator rather than adapt to the class. A2 has the same shape from the other side: two
functions named `percentile`, one taking percent and one taking a fraction. When a home's interface
does not match the call shape, deduplicating by pointing everyone at the home is the wrong fix — the
home's surface has to change first.

## A — the home exists and the code bypasses it

### A1. `link-dev-weights.ts` — nine forks, all different, already diverged

Every `neural-weights-*` workspace carries its own copy. Nine files, nine distinct md5s, sizes from
96 to 512 lines:

```
neural-weights-base-latn/scripts/link-dev-weights.ts    96 lines
neural-weights-de-de/scripts/link-dev-weights.ts       117
neural-weights-en-in/scripts/link-dev-weights.ts       121
neural-weights-es-es/scripts/link-dev-weights.ts       117
neural-weights-it-it/scripts/link-dev-weights.ts       117
neural-weights-fr-fr/scripts/link-dev-weights.ts       286
neural-weights-en-nz/scripts/link-dev-weights.ts       318
neural-weights-en-us/scripts/link-dev-weights.ts       441
neural-weights-en-gb/scripts/link-dev-weights.ts       512
```

Shared units the clone scan matched across them: `linkForce` (×5), `peekPairIndexHeaderFields` (×5),
`md5FileWithSidecar` (×2), `removeIfPresent` (×2).

> **CORRECTED 2026-08-02, before touching it — the size spread is mostly BY DESIGN.** Reading
> `package.json` across the nine: `en-us` and `base-latn` are BASE packages (their `files` ship
> `model.onnx` + `tokenizer.model`); the other seven declare
> `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"` and are OVERLAYS whose `files` ship only
> locale artifacts. So the four ~117-line scripts linking nothing but `pair-index-<cc>.bin` are
> correct for what those packages are, not evidence of drift. The audit read nine different files as
> nine forks of one thing; they are two bases and seven overlays.
>
> **A real question survives, and it is narrower.** Among the seven overlays, three (`en-gb`, `en-nz`,
> `fr-fr`) additionally link the BASE artifacts — `model.onnx`, `tokenizer.model`,
> `anchor-lexicon-v1.json`, `country-surface-lexicon-v1.json` — into their workspace for local dev,
> and four (`de-de`, `es-es`, `it-it`, `en-in`) do not. Whether that split is intentional (only the
> three are ever exercised standalone) or is the actual gap cannot be settled from the files alone.
> **That is the operator's call, and it is the reason this cluster was ranked "wants a second pair of
> eyes" rather than executed.**

**Cost of leaving it: still the highest in the audit, for a different reason.** Nine scripts, nine
md5s, and the shared helpers (`linkForce` ×5, `peekPairIndexHeaderFields` ×5, `md5FileWithSidecar`
×2, `removeIfPresent` ×2) are duplicated regardless of which package needs which artifact.
`AGENTS.md` documents this script as one of four cooperating pieces (`copy-weights.ts`,
`weights.test.ts`, the publish tarball symlink guard); the per-package artifact LIST is legitimately
per-package, but the machinery that does the linking is not.

**Cost of fixing it: high**, and the shape is now clearer. The refactor is: one shared linker
holding the machinery, plus a per-package manifest declaring which artifacts that package links —
base or overlay. The manifest content is exactly the question above, which is why the split has to
be decided before the module is written, not during.

**Proposed home:** a `neural-weights-kit` (or `scripts/link-dev-weights.ts`) holding `linkForce`,
`peekPairIndexHeaderFields`, `md5FileWithSidecar` and `removeIfPresent`, with each workspace's script
reduced to its artifact manifest plus one call.

### A2. Percentile / stats — the home was created for this and the copies came back

`core/utils/stats.ts` exists specifically for this. Its own docstring:

> Small stats helpers — the canonical home for the `percentile`/`median` copies (~15) and the `pct`
> percentage-format lambdas (~40) the 2026-07-09 dedupe survey found across eval scripts.

Still outside it:

| site                                                                                 | what                               |
| ------------------------------------------------------------------------------------ | ---------------------------------- |
| `scripts/eval/conformal-calibrate.ts:107,114`                                        | `percentile` + `median`            |
| `mailwoman/eval-harness/poi-board.ts:428`                                            | `quantile`                         |
| `scripts/eval/postcode-anchor-accuracy.ts:65`                                        | `pct` (a percentile)               |
| `scripts/eval/fr-admin-split-gate.ts:141`                                            | `pct` (a percentile)               |
| `scripts/eval/fr-admin-split-selfvalidation.ts:115`                                  | `pct` (a percentile)               |
| `scripts/eval/rescore-ceiling-probe.ts:60`                                           | `pct` (a percentile)               |
| `registry/tools/learned-scorer-clustering-eval.ts:416`, `…crossstate-eval.ts:363`    | `quantileThresholds` ×2            |
| `registry/tools/train-{cross-gbt:135,gbt:141,org-cross-gbt:117}.ts`                  | `uniqueQuantiles` ×3               |
| `registry/tools/learned-scorer-clustering-eval.ts:455`, `learned-scorer-eval.ts:539` | `mean` ×2                          |
| ~20 further sites                                                                    | surviving `pct` percentage lambdas |

**The sharpest receipt:** `scripts/eval/conformal-calibrate.ts:55` already imports from
`@mailwoman/core/utils` — the same barrel that exports `percentile` — and then defines its own
`percentile` and `median` fifty lines later.

**Complication, and why this is not one mechanical sweep.** The two `percentile`s take different
units: core's takes percent (`p` in `[0,100]`), `conformal-calibrate.ts`'s takes a fraction
(`0.9` → 90th). A find-and-replace produces a silently wrong number, not a compile error. Core's
docstring also warns that gate parity depends on its exact nearest-rank semantics.

**Cost of leaving it: medium.** Silent divergence in gate numbers.
**Cost of fixing it: low per site, but every site needs its unit convention checked.**

### A3. Seeded PRNGs — sixteen copies of three generators

| generator                          | copies | sites                                                                                                                                                                                                                    |
| ---------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mulberry32`                       |      4 | `corpus/src/synthesize.ts:219`, `corpus/src/synthesize-boundary-stress.test.ts:22`, `corpus/src/synthesize-intersection.test.ts:26`, `scripts/eval/boundary-stress-gate.ts:70`                                           |
| LCG as `seededRandom`/`makeRandom` |      5 | `corpus/src/adapters/synth-po-box/adapter.ts:76`, `corpus/src/synthesize-{house-venue:11,no-street:20,po-box:21,street:11}.test.ts`                                                                                      |
| LCG as `lcg`/`seeded`              |      7 | `registry/tools/{learned-scorer-clustering-eval:134,learned-scorer-eval:153,train-cross-gbt:122,train-gbt:128,train-org-cross-gbt:104}.ts`, `corpus/src/synthesize-anchor-absorption.test.ts:14`, `match/gbt.test.ts:14` |

`core/utils/python-random.ts` exports `SeededRandom`, and its docstring says it is "Backed by
mulberry32". One caller uses it: `scripts/eval/build-oa-coord-golden.ts:149`.

**Diagnosis — the home's shape is the problem, not its absence.** `SeededRandom` is a class you call
`.random()` on. Every call site above wants `() => number`, because that is what the synthesizers and
samplers take as an injected `random` option. The copies are not ignorance of the home; they are the
cheapest way to get the shape the call site needs.

**Proposed fix:** export a thunk form (`mulberry32(seed): () => number`) from
`core/utils/python-random.ts` alongside the class, then repoint. Do not force sixteen call sites into
the class.

**Cost of leaving it: low-medium** (determinism is per-copy, so nothing breaks — but the LCG copies
and the mulberry32 copies produce different streams under the same seed, which makes "same seed, same
result" false across files that look like they agree).
**Cost of fixing it: low** once the thunk exists.

### A4. HTTP — `APIClient` is declared mandatory; 28 raw-`fetch` sites remain

`AGENTS.md` states the rule and then closes with a claim of completion:

> **HTTP clients extend or instantiate `APIClient`** (`@mailwoman/core/api`), not raw `fetch`. […]
> No raw-`fetch` client remains.

**The claim is false.** 28 `fetch(` call sites across 19 files, outside browser and test code. The ones that
re-implement what `APIClient` provides (retry, timeout, pacing, error classification):

- `corpus/src/tools/fetch/download.ts:93` — hand-rolled retry loop with `AbortSignal.timeout`
- `corpus/src/tools/fetch/{nad.ts:103,121, nppes.ts:59, openaddresses.ts:167,266, tiger-full.ts:108,208}`
- `tiger/sdk/fetch.ts:199,212` and `tiger/sdk/redistricting.ts:134` — plus `downloadIfNeeded` and
  `runCapture` cloned between those two files
- `osm/sdk/fetch.ts:36`

`AGENTS.md` names `sdk/` as the data-acquisition layer and points at `filer/sdk/sec-client.ts` and
`bdc/sdk/client.ts` as the worked examples. `osm/sdk` and `tiger/sdk` are that same layer and do not
follow the pattern the other two demonstrate.

Remaining sites are one-shot tool downloads where the case is weaker but the rule still reads as
absolute: `codex/tools/{generate-country-reference.ts:100,generate-official-languages.ts:67}`,
`core/tools/download-ssl-address.ts:53,65`, `poi-taxonomy/scripts/generate-taxonomy.ts:213`,
`mailwoman/release-tools/publish-hf.ts:134,428`, `scripts/check-release-parity.ts:71,144`,
`spatial/geometries/polygon.ts:231` (Overpass), `corpus/src/tools/golden-expand.ts:346,380`,
`mailwoman/eval-harness/gauntlet/build-fdic-holdout.ts:81`,
`nominatim/dev-tools/capture-search-golden.run.ts:56,73`, `scripts/eval/fullstack-compare.ts:262`.

**Whatever is decided about the code, `AGENTS.md`'s closing sentence needs correcting** — an
instruction file that asserts a finished state that is not finished teaches the next agent that the
rule is decorative.

**Cost of leaving it: medium** for the SDK fetchers (no pacing means the lab can get rate-limited on
a re-fetch), **low** for the one-shot tools.
**Cost of fixing it: medium** — `APIClient` is axios-based, so each migration is a real rewrite.

### A5. Hashing — `core/utils/hash.ts` exists; 10 files call `createHash` directly

`sha256File` / `sha256Hex` / `md5File` are exported. Direct `createHash` callers:

```
address-id/index.ts
ban/scripts/build-address-point-shard.ts      ┐ fileMD5 cloned between these two
ban/scripts/build-street-centroid-shard.ts    ┘
corpus/src/{adapter,parquet,split}.ts
filer/tools/linkage-corpus.ts
mailwoman/eval-harness/gauntlet/harness.ts
neural-weights-en-{gb,us}/scripts/link-dev-weights.ts   (see A1)
```

Check `address-id/index.ts` before touching it — the address primary key is a wire contract and its
digest construction may be deliberate.

**Cost of leaving it: low.** **Cost of fixing it: low**, except `address-id`.

### A6. JSONL — `core/utils/jsonl.ts` exists; 10 files hand-roll split-and-parse

Nine files import `readJSONL`/`writeJSONL`/`iterateJSONL` correctly. Ten do not:
`corpus/src/golden.ts`, `corpus/src/shard-recipes/intersection.ts`,
`mailwoman/dev-tools/failure-report.run.ts`, `poi-taxonomy/scripts/generate-taxonomy.ts`,
`scripts/eval/postcode-anchor-accuracy.ts`, and five `corpus/src/**/*.test.ts` files.

This is drift against a known home, not an unknown one — the adoption split is roughly even.

**Cost of leaving it: low** (until a file needs the streaming `iterateJSONL` and grows a second
hand-rolled reader). **Cost of fixing it: low, mechanical.**

### A7. Data root — the `/mnt/playpen` literal is meant to live in exactly one file

`AGENTS.md`: "The lab `/mnt/playpen/mailwoman-data` default lives in **exactly one place**
(`data-root.ts`); never re-hardcode it in shipped code or scripts. In docs/comments/help-text
reference `$MAILWOMAN_DATA_ROOT`, not the literal."

121 files use `dataRootPath`/`mailwomanDataRoot` — the discipline mostly holds. The leaks:

| kind      | site                                                                                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **code**  | `corpus/src/tools/shard-translit.ts:56,167`; `mailwoman/commands/corpus/shard/translit.tsx:26`                                                                                                                              |
| **tests** | `mailwoman/commands/geocode.test.ts:40,41`; `neural/fst-prior.test.ts:28`; `neural/placetype-pair-prior.test.ts:51`; `neural/test/capability-gate.test.ts:36,37`                                                            |
| **prose** | `corpus/src/tools/corpus-stats.ts:35`; `corpus/src/tools/fetch/{index.ts:68,nad.ts:29,openaddresses.ts:47}`; `mailwoman/gazetteer-pipeline/postcode/zcta-centroids.ts:23`; `mailwoman/commands/corpus/shard/translit.tsx:9` |

The `shard-translit` pair is the one that matters: the literal is a **runtime default value**
(`options.legacyPathPrefix ?? "/mnt/playpen/mailwoman-data/"`), so a lab with a different data root
gets a silently wrong path rewrite.

**Cost of leaving it: low-medium** (one real behavioural default; the rest is prose hygiene).
**Cost of fixing it: low, mechanical.**

### A8. String comparators — `@mailwoman/match` is the home; `jaccard` lives outside it ×3

`match/comparators.ts` exports `jaro`, `jaroWinkler`, `levenshteinSimilarity`, `nameSimilarity`. It
does not export `jaccard`, so three copies grew in `registry/tools`:

```
registry/tools/dedup-ceiling.ts:103          jaccard
registry/tools/gold-set-sample.ts:88         jaccard
registry/tools/nppes-dedup-benchmark.ts:186  orgJaccard
```

Cloned alongside them, same file pairs: `norm` (×2), `orgTokens` (×2), `addr` (×2), `sigmoid` (×2).
`registry` already depends on `match` — this is a missing export, not a missing dependency.

**Cost of leaving it: medium** — `registry` is the record-matching app; a comparator that disagrees
with the matcher's own comparators is a correctness surface.
**Cost of fixing it: low** — add `jaccard` to `match/comparators.ts`, repoint three sites.

## B — orphan duplication (each cluster names its proposed home)

### B1. Point-in-polygon — three implementations in three published packages

```
nuts-lookup/index.ts:37,54          pointInRing + pointInPolygon   (byte-identical to timezone-lookup)
timezone-lookup/index.ts:24,44      pointInRing + pointInPolygon
resolver-wof-sqlite/geo.ts:89,111   pointInRing + pointInPolygonRings  (readonly GeoJSON types)
```

`nuts-lookup` and `timezone-lookup` are byte-identical, `MultiPolygonCoords` type included.

**The telling detail:** `resolver-wof-sqlite/geo.ts:21-23` explicitly defers to spatial for distance —

> `haversineKm` is the canonical implementation in `@mailwoman/spatial`; re-exported so this package's
> callers have one import.

— and then keeps its own point-in-polygon twenty lines below, because `@mailwoman/spatial` does not
have one. The author knew the rule and could not follow it for PIP.

**Proposed home:** `spatial/geometries/polygon.ts`. `AGENTS.md` already calls spatial "the math
home"; PIP is the gap that makes the claim untrue.
**Cost of leaving it: medium** (three packages, ray-cast edge cases, no shared tests).
**Cost of fixing it: low-medium** — one new export, three call sites, and the resolver variant's
`readonly` GeoJSON types need to be the shared signature.

> **CORRECTED ON IMPLEMENTATION.** Only the resolver moved. `nuts-lookup` and `timezone-lookup` each
> carry exactly one dependency (zero-dep `@mailwoman/annotations`); importing spatial to reach the
> ray cast would pull `@mailwoman/core` and its ~11 MB of shipped data into two leaf packages. That
> is a three-order-of-magnitude weight increase for fifteen lines, so both keep their copies with the
> measurement recorded in place. The audit priced the duplication and not the dependency; reading the
> graph before moving is what caught it.

### B2. corpus adapters — the same regex ten times, the same splitter eight times

`const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/` — byte-identical in **ten** files:

```
corpus/src/adapters/fcc-bdc/adapter.ts:78                        corpus/src/adapters/usgov-hrsa-fqhc/adapter.ts:78
corpus/src/adapters/state-hi-schools/adapter.ts:52               corpus/src/adapters/usgov-imls-pls/adapter.ts:41
corpus/src/adapters/state-ia-contractors/adapter.ts:39           corpus/src/adapters/usgov-irs-bmf/adapter.ts:41
corpus/src/adapters/state-ny-notaries/adapter.ts:37              corpus/src/adapters/usgov-nppes/adapter.ts:44
corpus/src/adapters/state-tx-notaries/adapter.ts:38              corpus/src/adapters/usgov-samhsa-treatment-locator/adapter.ts:69
```

`function splitAddress(address)` — byte-identical in **eight** of those (all but `fcc-bdc` and
`usgov-irs-bmf`). `composeRaw` is cloned in two more (`usgov-hrsa-fqhc:99`,
`usgov-samhsa-treatment-locator:125`).

**Cost of leaving it: medium.** This regex decides where the house number ends and the street begins
for ten corpus sources. Fixing a parsing edge case means finding all ten, and nothing points from one
to the others.
**Cost of fixing it: lowest in the audit** — pure mechanical extraction, no semantics to reconcile.
**Proposed home:** `corpus/src/adapters/shared.ts`, or `@mailwoman/normalize` if the split belongs to
deterministic preprocessing rather than to corpus ingestion.

### B3. Python-parity numerics in the gazetteer pipeline

```
pyRound            ×4   mailwoman/gazetteer-pipeline/anchor-lookup.ts:100, postcode-locality/{base:83,jp:100,kr:94}.ts
incDecimalString   ×4   …/anchor-lookup.ts:73, postcode-locality/{base:56,jp:73,kr:67}.ts
pyFloat            ×3   …/anchor-lookup.ts:150, postcode-locality/{jp:150,kr:151}.ts
```

`core/utils/{python-json,python-random}.ts` already establish "python-parity helpers" as a category
that lives in `core/utils`.

**Cost of leaving it: medium** — these exist to match a Python original bit-for-bit. Four copies
means four chances to drift from the reference, and the drift is invisible until a shard differs.
**Cost of fixing it: low.** **Proposed home:** `core/utils/python-numeric.ts`, beside its siblings.

### B4. `splitCSV` ×6 in corpus shard recipes

Two variants, four copies and two copies:

```
corpus/src/shard-recipes/{fr-order:76, intersection:162, street-affix:137, unit:120}.ts   (variant 1)
corpus/src/shard-recipes/{german:47, po-box-cedex:220}.ts                                 (variant 2)
```

**Proposed home:** `corpus/src/shard-recipes/csv.ts`. Reconcile the two variants first — the split is
where the difference is hiding.
**Cost of leaving it: low-medium.** **Cost of fixing it: low.**

### B5. `swapDatabaseIntoPlace` ×2 — this is the documented build-then-swap rule

`mailwoman/commands/situs/address-points.tsx:85` and `…/interpolation-shard.tsx:148`, identical:
rename the live DB aside, clear `-wal`/`-shm`, rename the new one in, drop the aside.

This is `AGENTS.md`'s database rule implemented in code:

> take care to build it successfully, then move the previous version to a temp directory, and then
> move the new version into place.

A rule the project states in prose and implements twice in code should be a function.

**Proposed home:** `core/utils/sealed-db.ts` — it already owns `sealDatabase` and
`openBuiltDatabase`, so the artifact lifecycle is its subject.
**Cost of leaving it: medium** — one copy getting the `-wal` cleanup wrong corrupts a shipped
artifact. **Cost of fixing it: low.**

### B6. `v0-tree-adapter.ts` — a whole file duplicated, with a written exit plan nobody ran

`mailwoman/eval-harness/v0-tree-adapter.ts` and `scripts/eval/v0-tree-adapter.ts` differ in **four
lines, all docstring.** The code is identical. Each file's docstring says the other is the copy:

> NOTE(phase5a): this is a COPY of `scripts/eval/v0-tree-adapter.ts` […] The original stays behind
> because two probes pending triage (`resolver-eval.ts`, `fr-admin-split-selfvalidation.ts`) still
> import it; the probe triage should delete that copy and repoint any survivor here.

The triage never happened. Both named probes still exist.

**Cost of leaving it: low today, and it is the cheapest cluster to close.**
**Cost of fixing it: low** — triage the two probes, delete one file.

### B7. docs ↔ react component forks, after the port was called complete

Six same-named components exist in both `docs/src/components/` and `react/`, diverged:

| component              | docs | react | differing lines |
| ---------------------- | ---: | ----: | --------------: |
| `PipelineExplorer.tsx` |  292 |   161 |             399 |
| `ResultPanel.tsx`      |  233 |    98 |             281 |
| `POIExplorer.tsx`      |   80 |   143 |             185 |
| `LoadingIndicator.tsx` |  159 |   119 |             154 |
| `CandidatePicker.tsx`  |   40 |    45 |              45 |
| `KindBadge.tsx`        |   42 |    44 |              34 |

Plus `KindBadge.stories.tsx`, `LoadingIndicator.stories.tsx`, `styles.css`.

`KindBadge` read in full: same markup tree, same `formatPct` helper, same behaviour. The only real
differences are CSS-module class names versus BEM strings, and a locally-imported `KindResult` type
versus react's structural `KindBadgeResult`. React's copy says in its docstring that it is "Shared by
both explorers" — docs did not take it.

Some docs components (`POIExplorer`, `PipelineExplorer`) do import `@mailwoman/react`, so the port is
partial rather than absent.

**Cost of leaving it: medium** — a UI fix has to be made twice, and the two copies are already
visibly different sizes.
**Cost of fixing it: medium** — needs a decision on whether react's components take a className/theme
prop so Docusaurus styling survives.

### B8. Small shipped-package clusters

| cluster                  | sites                                                                   | proposed home                    |
| ------------------------ | ----------------------------------------------------------------------- | -------------------------------- |
| `foldName` ×3            | `codex/{ca/province.ts:74, country/subdivision.ts:53, fr/region.ts:71}` | `codex/normalize.ts`             |
| `isStreetAffix` ×2       | `neural/fst-prior.ts:396`, `neural/trailing-locality-prior.ts:125`      | shared neural prior helper       |
| `setLabel` ×2            | `neural/postcode-repair.ts:155`, `neural/unit-repair.ts:143`            | shared neural repair helper      |
| `isFinitePair` ×2        | `osm/sdk/{extract-poi.ts:233, extract.ts:58}`                           | `osm/sdk/shared.ts` or `spatial` |
| `add` ×2                 | `poi-taxonomy/{brands-lookup-core.ts:54, lookup-core.ts:53}`            | `poi-taxonomy/lookup-shared.ts`  |
| `pointInRing` companions | see B1                                                                  | —                                |
| `rowsFromExec` ×2        | `docs/src/shared/{httpvfs-street.ts:46, poi-httpvfs.ts:51}`             | `docs/src/shared/httpvfs.ts`     |

`codex` is the zero-runtime-dependency reference package — three copies of a name-folding function in
a package whose whole job is normalized reference data is the one worth doing first here.

### B9. Lexicon-normalization trio, copied as a group

`wordNorm` (×3), `isShortCode` (×3), `norm` (×2) across:

```
codex/tools/build-country-surface-lexicon.ts:74,81,86
mailwoman/commands/gazetteer/anchor-lexicon.tsx:64,74,79
mailwoman/gazetteer-pipeline/evidence-lexicons.ts:541,548
```

Three helpers copied together across three workspaces is a module that was never extracted.
**Proposed home:** `mailwoman/gazetteer-pipeline/lexicon-normalize.ts`, exported for `codex/tools`.

### B10. Drop-in API route plumbing

`legacyQuery` (`nominatim/routes.ts:75`, `photon/routes.ts:62`) and `errorContent`
(`libpostal/routes.ts:60`, `nominatim/routes.ts:123`). `api-kit` is the declared plumbing home and
all three packages already depend on it.
**Cost of fixing it: low.** Note the envelope _shapes_ must stay per-package — see rejected #5.

### B11. `registry/tools` has no shared module

Beyond A2/A8: `buildSpecs` ×3 (`coverage-reconciliation:95`, `cross-dataset-correlation:117`,
`cross-source-threshold-sweep:95`), `seam` ×2, `mappingFor` ×2, `addr` ×2, four variants of `norm`.
Twenty-four tool scripts, no `registry/tools/shared.ts`.
**Cost of leaving it: low** (tools, not shipped runtime) **but it is where new copies keep landing.**

### B12. Byte formatting ×4

`humanBytes` ×2 (`corpus/src/tools/fetch/{openaddresses.ts:135, tiger-full.ts:80}`) and `iec` ×2
(`corpus/src/tools/fetch/{ban.ts:162, state-hi-schools.ts:102}`) — two names, one job, four copies,
all in the same directory. **Proposed home:** `corpus/src/tools/fetch/format.ts`.

### B13. `tiger/sdk` internal duplication

`downloadIfNeeded` ×2 and `runCapture` ×2 between `tiger/sdk/fetch.ts:172,187` and
`tiger/sdk/redistricting.ts:107,122`. Same package, adjacent files. Overlaps with A4 — if these move
to `APIClient`, they collapse anyway.

### B14. Test fixture builders rebuilt per file

`mailwoman/test-kit` exists (6 importers across 422 test files). The repeated builders:

```
resolver/*.test.ts        node ×6, localityOf ×3, makeBackend ×2, regionOf ×2
neural/*.test.ts          makePieces ×4
neural-web/*.test.ts      installMockSession ×2
{bdc,filer}/sdk/*.test.ts axiosLikeError ×2
react/map/*.test.tsx      settle ×2
mailwoman/test/*.test.ts  captureResolver ×2, weightsPresent ×2
corpus/src/*.test.ts      writeCSV ×2, baseRow ×2
```

The `resolver` cluster is the one worth extracting — six copies of a `node` fixture builder and three
of `localityOf` across six files that all test the same resolver.

**Cost of leaving it: low** (test-local duplication is the cheapest kind).
**Cost of fixing it: low.** Do this one last.

## C — idiom drift

Four of the five conventions checked are **holding**, with zero violations:

- `erasableSyntaxOnly` — 0 `enum`, 0 runtime namespaces (the single `namespace NodeJS` hit is an
  ambient `.d.ts` declaration, which is permitted)
- explicit `.ts` extensions on relative imports — 0 missing
- raw `process.env` / `process.argv` outside the blessed homes — 0
- `AGENTS.md`'s own claimed-zero acronym pattern (`Json|Jsonl|Http|Api|Url|Uri` on exports) — **0,
  claim verified**

### C1. Acronym casing — the swept list is clean, and new acronyms drifted in behind it

`AGENTS.md` (reconciled 2026-07-25) claims: "A grep for any **exported** lowercase-acronym identifier
(`Json|Jsonl|Us[A-Z]|Http|Api|Url`) across all published workspaces returns **zero**." That is
**true**. But the sweep was keyed to a fixed list, and acronyms outside it drifted freely:

| acronym | house form (occurrences)                                                         | drifted exports                                                                                                                   |
| ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POI     | `POI*` — `POILookup` ×81, `POISourceRow` ×26, `POIDatabase` ×26, `POIIntent` ×24 | `PoiBoard*` ×10 exports, `mailwoman/eval-harness/poi-board.ts:52,65,70,74,76,86,238,403,423,459`                                  |
| NZ      | upper 64 / lower 25                                                              | `Nz*` ×12 exports, `codex/nz/{delivery-service.ts:48,53,97,152,176,207,225,233, postcode.ts:26,36,46}`                            |
| NUTS    | upper 13 / lower 12                                                              | `annotations/index.ts:71 Nuts`, `nuts-lookup/build.ts:24 buildNutsDB`, `nuts-lookup/index.ts:93,132 NutsLookup/makeNutsAnnotator` |
| CRF     | upper 6 / lower 2                                                                | `neural/weights.ts:699,709 CrfTransitions/readCrfTransitions`                                                                     |
| GBT     | upper 2 / lower 0                                                                | `registry/learned-scorer.ts:133 createGbtScorer`                                                                                  |

**The sharpest receipt is intra-file.** `codex/nz/delivery-service.ts` declares
`NZ_DELIVERY_SERVICE_TYPES` at line 73 and `NzDeliveryServiceTypeName` at line 97 — the same acronym,
two casings, twenty-four lines apart.

**Root cause, and why a sweep alone will not hold.** `AGENTS.md` says it plainly: "There's no lint
rule for this (oxlint can't express it); it's reviewer discipline." A convention enforced only by
review, swept only against a fixed acronym list, will keep regrowing at every acronym not on the
list. The durable fix is a check — a small script over exported identifiers with a project acronym
list, run in CI — not another sweep.

**Cost of leaving it: low** (cosmetic) **except for `POI`**, where the drift is against 250+
occurrences of the opposite form in the same repo.
**Cost of fixing it: low** for `Poi`/`Crf`/`Gbt` (internal, no public export moves). `Nz*` and
`Nuts*` are **public exports of published packages** (`@mailwoman/codex`, `@mailwoman/nuts-lookup`,
`@mailwoman/annotations`) — those are breaking renames and belong in a major, per the precedent
`AGENTS.md` records for the v5.0.0 batch.

## D — altitude (observation, not a verdict)

I did not do the per-file read that calling a boundary problem requires. What the size ranking shows,
with the shape of each file characterized cheaply:

| file                                                  | lines | exports | fns | reading                             |
| ----------------------------------------------------- | ----: | ------: | --: | ----------------------------------- |
| `mailwoman/eval-harness/gauntlet/cases/regression.ts` |  2291 |       2 |   0 | case table — **not a finding**      |
| `mailwoman/eval-harness/oa-resolver-eval.ts`          |  1391 |       — |   — | eval harness                        |
| `neural/classifier.ts`                                |  1370 |       6 |   3 | few exports, coherent               |
| `resolver-wof-sqlite/lookup.ts`                       |  1315 |       4 |   0 | one large class                     |
| `filer/sdk/build-filer.ts`                            |  1293 |       4 |  18 | build script                        |
| `resolver/resolve.ts`                                 |  1145 |       1 |  15 | one entry point, 15 private helpers |
| **`mailwoman/geocode-core.ts`**                       |  1045 |  **17** |  11 | **the one worth a look**            |

`geocode-core.ts` is the outlier: seventeen exported symbols against eleven functions, in a thousand
lines. Breadth of exported surface is the signal that a module is answering to several callers for
several reasons. **This is a flag for a reader, not a finding** — confirming it needs the read I did
not do.

## Appendix — rejected candidates

Each of these survived a grep and died on reading. Recorded so the next sweep does not re-propose
them.

1. **`match/distance.ts:31 haversineKm`** — not a second implementation. A documented adapter from
   `match`'s `LatLon` shape onto `spatial`'s scalar `haversineKm`, aliased on import as
   `greatCircleKm`. Its docstring says so.

2. **The whole great-circle cluster** — grep found lat/lon trigonometry in seven files outside
   `spatial/`. On reading: `resolver-wof-sqlite/geo.ts:23` **re-exports** spatial's;
   `mailwoman/gazetteer-pipeline/postcode-locality/{base,jp,kr,tw}.ts` all **import** it (`base.ts:45`,
   `tw.ts:59`); `match/distance.ts` is the adapter above. **Zero findings from the audit's first and
   most promising candidate set.**

3. **`resolver-wof-sqlite/street-centroid.ts:67 extentRadiusM`** — contains haversine-shaped
   trigonometry but is a bbox half-diagonal, and uses `cos(midLat)²` where great-circle distance uses
   `cos(lat₁)·cos(lat₂)`. A deliberate variant for a different quantity, not a copy.

4. **`api-kit/metrics.ts:52 percentile`** — a different function despite the name: takes a
   **pre-sorted** array, returns `0` (not `null`) on empty, rounds to two decimals. Written for a hot
   metrics path. Merging it into `core/utils/stats.ts` needs a judgment call about the contract, so it
   is not part of A2's mechanical sweep.

5. **`libpostal` / `nominatim` / `photon` error envelopes** — `{ error: "…" }` shapes that look like
   they should use `api-kit`'s `apiError`. They must not: these are drop-in replacements and their
   wire shape is the upstream project's contract. `libpostal/app.ts:21` records the decision
   explicitly ("a recorded free choice, shaped to match"). Route _plumbing_ can still be shared —
   see B10.

6. **`registry/tools/dedup-ceiling.ts:272`, `cross-source-threshold-sweep.ts:355`,
   `geocoder-vs-provided-coords.ts:81`** — all three alias or wrap `core/utils/stats`'s `formatPercent`
   / `percentile`. Good citizens that a `const pct =` grep flags as copies.

7. **`docs/src/components/{SpanHighlight,TreeView,…} tier()` ×5** — matched as a 5-copy clone group,
   but each already delegates to a shared `confidenceTier`. Only a two-line null-guard repeats.
   Marginal at best.

8. **`mailwoman/types/node.d.ts:7 namespace NodeJS`** — the only `namespace` in the repo, and legal:
   an ambient declaration in a `.d.ts`, which `erasableSyntaxOnly` permits.

9. **Everything on `AGENTS.md`'s "What deliberately stays raw" list** — `candidate-fts.ts:39`'s
   `CREATE VIRTUAL TABLE … USING fts5`, `coincident-roles.ts:205`, `build-slim.ts`'s
   introspect-and-replay, `zcta-centroids.ts`'s sync DDL, the hot positional INSERT loops. Documented
   decisions with reasons attached; migrating one regresses it.

10. **`gauntlet/cases/regression.ts` at 2291 lines** — a data table with two exports and zero
    functions. Long is not the same as doing too much.

11. **`nuts-lookup` / `timezone-lookup` point-in-ring, and `match/gbt.test.ts`'s LCG** — real,
    verified duplicates of code that now has a shared home, and they stay duplicated. Each package
    would have to take a dependency whose published weight is three orders of magnitude larger than
    the code it deduplicates (`@mailwoman/spatial` → `@mailwoman/core` → ~11 MB of data;
    `@mailwoman/match` has no core dependency at all today). Recorded in each file so the next sweep
    finds the reasoning instead of the copy. **A duplicate with a priced reason is a decision, not a
    defect** — this is the category the audit's own B-axis was missing.

## What this audit did not cover

- `corpus-python` (out of scope by the charter).
- Bug hunting. Where duplication is also wrong, the wrongness is noted but not chased.
- The per-file reads that axis D would need to produce verdicts rather than a flag.
- Clone detection was body-hash based (`scripts/diagnostic/clone-scan.ts` — tracked as a keeper
  under the `.gitignore:169` rule, since this document cites it): extract each function body by
  brace-matching, strip comments,
  collapse whitespace, replace the declared name with a placeholder so renamed copies still collide,
  then hash. It finds **identical** normalized bodies across files — 83 cross-file groups over 3,123
  units in 1,570 files. Near-duplicates that drifted by a line are invisible to it, so every count in
  this document is a floor, not a ceiling. Bodies under four lines or 120 normalized characters were
  skipped, so trivial one-liner repeats are also under-counted.

## Appendix: the embedded-newline census (2026-08-03)

The CSV parse fix only changes shard bytes for a source that actually carries a newline inside a
quoted field. That is measurable rather than arguable, so it was measured — every OpenAddresses
member reachable on the lab host, scanned for lines with an odd number of quotes:

| source                | member                 |          lines | odd-quote | shard effect                               |
| --------------------- | ---------------------- | -------------: | --------: | ------------------------------------------ |
| `europe.zip`          | `fr/countrywide.csv`   |     25,414,422 |         2 | none — stride skips it                     |
| `europe.zip`          | `de/berlin.csv`        |        375,341 |         0 | none                                       |
| `europe.zip`          | `de/sn/statewide.csv`  |        962,817 |         0 | none                                       |
| `ch__countrywide`     | `ch/countrywide.csv`   |      2,759,182 |         0 | none                                       |
| `no__countrywide`     | `no/countrywide.csv`   |      1,904,206 |         0 | none                                       |
| `it__countrywide`     | `it/countrywide.csv`   |              — |         0 | none (equivalence-proven)                  |
| `nl__countrywide`     | `nl/countrywide.csv`   |              — |        >0 | none (equivalence-proven)                  |
| **`es__countrywide`** | **`es_addresses.csv`** | **15,627,792** |    **52** | **CHANGES `locale.ts`'s ES pedanía shard** |

Two findings worth keeping.

**FR has exactly one such record** — `14ter,"Route de la Foret⏎route de la Foret",Biard,86580`, at
physical lines 22,849,586–87. Neither is `≡ 3 (mod 211)`, so `readFrTuples`' stride steps over both
halves and the shard is unchanged. That is luck, not design, and the reason the pre-filter hazard is
documented in place at `po-box-cedex.ts` rather than fixed: a halved record fails the field checks
and drops, so the failure mode is a lost row, not a corrupt one.

**ES is the real one.** 52 odd-quote lines = 26 records, all the same Catastro shape — a quoted field
holding nothing but a newline, sitting between the house number and the postcode:

```
…,POL INDUSTRIAL VIAL B,"10",,
","16210","16042",Campillo de Altobuey,Cuenca,…
```

The old quote-blind splitter turned each into two rows: one truncated, one whose `16210` postcode
landed in a column expecting something else. The new parse yields 26 correct rows. So the ES pedanía
shard SHOULD change, and needs re-pinning deliberately — this is the corruption the change fixes,
visible in the output.

**Still unscanned:** the seven `us__*` zips and the GeoNames dumps, absent from this host. Same
one-liner closes them:

```
unzip -p <zip> <csv> | awk '{n=gsub(/"/,"&"); if(n%2==1) odd++} END{print FILENAME, NR, odd+0}'
```

Zero means that recipe's shards are untouched and need no attention. Nonzero means re-pin it.
