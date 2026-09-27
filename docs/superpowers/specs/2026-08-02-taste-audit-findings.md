# Repo-wide taste audit — findings

**Date:** 2026-08-02
**Base:** `origin/main` @ `9b46c82e`
**Scope + method:** [`2026-08-02-taste-audit-design.md`](./2026-08-02-taste-audit-design.md)
**Execution status:** sixteen of twenty-three clusters landed (see below).

## Status — 2026-08-02, after execution

Sixteen of the twenty-three clusters landed on `worktree-taste-audit` across 21 commits. Each commit
was checked against a recorded baseline of 4,617 passing tests taken before any edit, and `yarn compile`,
`yarn lint`, and the affected test projects passed on every commit.

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

- **A1**, the nine `link-dev-weights.ts` files, waits on a decision only the operator can make (below).
- **B7**, the docs↔react component forks, needs a decision on whether react's components take a
  className/theme prop so that Docusaurus styling survives. That is a design decision rather than a dedupe.
- **B12 and B14**, the byte formatters and test-fixture builders, are real and cheap to fix but have the lowest payoff. They are
  left for whoever next works in those files.

### Four findings this audit got wrong, corrected by implementing them

1. **The great-circle cluster** (7 candidates) produced **0 findings**. Five candidates imported the shared function, one was a
   documented adapter, and one was a deliberate variant for a different quantity.
2. **B1** proposed moving all three point-in-polygon copies to `@mailwoman/spatial`. `nuts-lookup` and
   `timezone-lookup` each carry one dependency (the zero-dependency `@mailwoman/annotations`), while spatial pulls in
   `@mailwoman/core` and its ~11 MB of shipped data. That is three orders of magnitude of weight for fifteen lines.
   One copy moved, and the other two are documented in place.
3. **A1** called nine files nine forks, citing a "4.3× size spread = divergence". Their
   `package.json` files show that two are base packages and seven declare `mailwoman.baseWeights` as
   overlays. The spread mostly reflects those two roles.
4. **A4** counted 28 raw-`fetch` sites as one population. They are two populations: ~23 API requests, which should migrate,
   and 4–5 multi-gigabyte file transfers streamed to disk, which should stay. Response caching makes no sense at
   that size, and axios buffers any non-stream response type in memory.

Each correction came from opening a `package.json` or a dependency graph, which the
grep-plus-read pass had skipped.

## Summary

| axis                      | clusters | sites | notes                                                     |
| ------------------------- | -------: | ----: | --------------------------------------------------------- |
| A — home exists, bypassed |        8 |   ~95 | the owning module is already written and already imported |
| B — orphan duplication    |       14 |  ~110 | no home yet; each cluster below names one                 |
| C — idiom drift           |        1 |   ~30 | acronym casing only; the other four conventions hold      |
| D — altitude              |        1 |     1 | observation rather than a verdict                         |
| rejected on reading       |       10 |   ~20 | see the appendix — do not re-propose these                |

**Shortlist to do first:**

- A1: nine forked `link-dev-weights.ts` files that have already diverged, with consequences already shipped.
- B2: ten byte-identical copies of the same regex and splitter. This is the cheapest fix
  in the audit.
- B1: three point-in-polygon implementations in three published packages.
- B6: a whole duplicated file whose written exit plan nobody executed.

**The common cause.** In three of the largest clusters, a home module exists, but the call sites could
not use it in its current shape. A3 is the clearest case.
`SeededRandom` in `core/utils/python-random.ts` is mulberry32 according to its docstring, but it is a class
with a `.random()` method, and all sixteen call sites want a `() => number` thunk. The sixteen sites
therefore rebuilt the generator instead of adapting to the class. A2 has the same problem from the other side: two
functions are named `percentile`, and one takes a percent while the other takes a fraction. When a home's interface
does not match the call shape, pointing every call site at the home is the wrong fix. The
home's interface has to change first.

## A — the home exists and the code bypasses it

### A1. `link-dev-weights.ts` — nine forks, all different, already diverged

Every `neural-weights-*` workspace carries its own copy. The nine files have nine distinct md5s and range from
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

> **Corrected 2026-08-02, before any edit: the size spread is mostly by design.** The nine
> `package.json` files show that `en-us` and `base-latn` are base packages, whose `files` ship
> `model.onnx` + `tokenizer.model`. The other seven declare
> `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"` and are overlays whose `files` ship only
> locale artifacts. The four ~117-line scripts that link only `pair-index-<cc>.bin` are therefore
> correct for their packages and do not show drift. The audit read nine different files as
> nine forks of one thing, but they are two bases and seven overlays.
>
> **A narrower question remains.** Among the seven overlays, three (`en-gb`, `en-nz`,
> `fr-fr`) also link the base artifacts (`model.onnx`, `tokenizer.model`,
> `anchor-lexicon-v1.json`, `country-surface-lexicon-v1.json`) into their workspace for local dev,
> and four (`de-de`, `es-es`, `it-it`, `en-in`) do not. The files alone cannot show whether that split is intentional
> (because only the three are ever run standalone) or is the actual gap.
> **The operator has to decide, and that is why this cluster was ranked "wants a second pair of
> eyes" instead of being executed.**

**Cost of leaving it: still the highest in the audit, for a different reason.** Nine scripts with nine
md5s duplicate the shared helpers (`linkForce` ×5, `peekPairIndexHeaderFields` ×5, `md5FileWithSidecar`
×2, `removeIfPresent` ×2) regardless of which package needs which artifact.
`AGENTS.md` documents this script as one of four cooperating pieces (`copy-weights.ts`,
`weights.test.ts`, and the publish tarball symlink guard). The artifact list belongs to each package, but the
linking implementation should be shared.

**Cost of fixing it: high**, and the shape of the fix is now clearer. It needs one shared linker
that holds the implementation, plus a per-package manifest that declares which artifacts the package links as a
base or an overlay. The manifest content depends on the question above, so the split has to
be decided before the module is written.

**Proposed home:** a `neural-weights-kit` (or `scripts/link-dev-weights.ts`) holding `linkForce`,
`peekPairIndexHeaderFields`, `md5FileWithSidecar` and `removeIfPresent`, with each workspace's script
reduced to its artifact manifest plus one call.

### A2. Percentile / stats — the home was created for this and the copies came back

`core/utils/stats.ts` was created for these helpers. Its docstring says:

> Small stats helpers — the canonical home for the `percentile`/`median` copies (~15) and the `pct`
> percentage-format lambdas (~40) the 2026-07-09 dedupe survey found across eval scripts.

These copies remain outside it:

| site                                                                                 | what                               |
| ------------------------------------------------------------------------------------ | ---------------------------------- |
| `scripts/eval/conformal-calibrate.ts:107,114`                                        | `percentile` + `median`            |
| `mailwoman/eval-harness/poi-board.ts:428`                                            | `quantile`                         |
| `scripts/eval/postcode-anchor-accuracy.ts:65`                                        | `pct` (a percentile)               |
| `scripts/eval/fr-admin-split-eval.ts:141`                                            | `pct` (a percentile)               |
| `scripts/eval/fr-admin-split-selfvalidation.ts:115`                                  | `pct` (a percentile)               |
| `scripts/eval/rescore-ceiling-probe.ts:60`                                           | `pct` (a percentile)               |
| `registry/tools/learned-scorer-clustering-eval.ts:416`, `…crossstate-eval.ts:363`    | `quantileThresholds` ×2            |
| `registry/tools/train-{cross-gbt:135,gbt:141,org-cross-gbt:117}.ts`                  | `uniqueQuantiles` ×3               |
| `registry/tools/learned-scorer-clustering-eval.ts:455`, `learned-scorer-eval.ts:539` | `mean` ×2                          |
| ~20 further sites                                                                    | surviving `pct` percentage lambdas |

**The clearest example:** `scripts/eval/conformal-calibrate.ts:55` already imports from
`@mailwoman/core/utils`, the barrel that exports `percentile`, and then defines its own
`percentile` and `median` fifty lines later.

**Why a mechanical sweep would be wrong.** The two `percentile` functions take different
units. Core's takes a percent (`p` in `[0,100]`), and `conformal-calibrate.ts`'s takes a fraction
(`0.9` → 90th). A find-and-replace would produce a silently wrong number instead of a compile error. Core's
docstring also warns that check parity depends on its exact nearest-rank semantics.

**Cost of leaving it: medium.** Check numbers can diverge silently.
**Cost of fixing it: low per site, but every site needs its unit convention checked.**

### A3. Seeded PRNGs — sixteen copies of three generators

| generator                          | copies | sites                                                                                                                                                                                                                    |
| ---------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mulberry32`                       |      4 | `corpus/src/synthesize.ts:219`, `corpus/src/synthesize-boundary-stress.test.ts:22`, `corpus/src/synthesize-intersection.test.ts:26`, `scripts/eval/boundary-stress-eval.ts:70`                                           |
| LCG as `seededRandom`/`makeRandom` |      5 | `corpus/src/adapters/synth-po-box/adapter.ts:76`, `corpus/src/synthesize-{house-venue:11,no-street:20,po-box:21,street:11}.test.ts`                                                                                      |
| LCG as `lcg`/`seeded`              |      7 | `registry/tools/{learned-scorer-clustering-eval:134,learned-scorer-eval:153,train-cross-gbt:122,train-gbt:128,train-org-cross-gbt:104}.ts`, `corpus/src/synthesize-anchor-absorption.test.ts:14`, `match/gbt.test.ts:14` |

`core/utils/python-random.ts` exports `SeededRandom`, and its docstring says it is "Backed by
mulberry32". One caller uses it: `scripts/eval/build-oa-coord-golden.ts:149`.

**Diagnosis: the home exists, but its shape does not fit.** `SeededRandom` is a class you call
`.random()` on. Every call site above wants `() => number`, because the synthesizers and
samplers take that shape as an injected `random` option. The authors likely knew about the home. Writing a copy was the
cheapest way to get the shape the call site needs.

**Proposed fix:** export a thunk form (`mulberry32(seed): () => number`) from
`core/utils/python-random.ts` beside the class, then repoint the call sites. Do not force sixteen call sites into
the class.

**Cost of leaving it: low-medium.** Each copy is deterministic on its own, so a change to one leaves the others unchanged. However, the LCG copies
and the mulberry32 copies produce different streams from the same seed, so "same seed, same
result" is false across files that appear to agree.
**Cost of fixing it: low** once the thunk exists.

### A4. HTTP — `APIClient` is declared mandatory; 28 raw-`fetch` sites remain

`AGENTS.md` states the rule and then claims that the migration is complete:

> **HTTP clients extend or instantiate `APIClient`** (`@mailwoman/core/api`) rather than raw `fetch`. […]
> No raw-`fetch` client remains.

**The claim is false.** Outside browser and test code, 28 `fetch(` call sites remain across 19 files. These sites
re-implement what `APIClient` provides (retry, timeout, pacing, error classification):

- `corpus/src/tools/fetch/download.ts:93`, a hand-rolled retry loop with `AbortSignal.timeout`
- `corpus/src/tools/fetch/{nad.ts:103,121, nppes.ts:59, openaddresses.ts:167,266, tiger-full.ts:108,208}`
- `tiger/sdk/fetch.ts:199,212` and `tiger/sdk/redistricting.ts:134`, with `downloadIfNeeded` and
  `runCapture` cloned between those two files
- `osm/sdk/fetch.ts:36`

`AGENTS.md` describes `sdk/` as the data-acquisition layer and cites `filer/sdk/sec-client.ts` and
`bdc/sdk/client.ts` as the worked examples. `osm/sdk` and `tiger/sdk` belong to the same layer but do not
follow the pattern of those two examples.

The remaining sites are one-shot tool downloads. The case for migrating them is weaker, but the rule is still written as
absolute: `codex/tools/{generate-country-reference.ts:100,generate-official-languages.ts:67}`,
`core/tools/download-ssl-address.ts:53,65`, `poi-taxonomy/scripts/generate-taxonomy.ts:213`,
`mailwoman/release-tools/publish-hf.ts:134,428`, `scripts/check-release-parity.ts:71,144`,
`spatial/geometries/polygon.ts:231` (Overpass), `corpus/src/tools/golden-expand.ts:346,380`,
`mailwoman/eval-harness/gauntlet/build-fdic-holdout.ts:81`,
`nominatim/dev-tools/capture-search-golden.run.ts:56,73`, `scripts/eval/fullstack-compare.ts:262`.

**Whatever is decided about the code, the closing sentence in `AGENTS.md` needs correcting.** When an
instruction file claims that unfinished work is finished, the next agent learns that the
rule is not enforced.

**Cost of leaving it: medium** for the SDK fetchers, because without pacing the lab can be rate-limited on
a re-fetch. **Low** for the one-shot tools.
**Cost of fixing it: medium.** `APIClient` is axios-based, so each migration is a real rewrite.

### A5. Hashing — `core/utils/hash.ts` exists; 10 files call `createHash` directly

`sha256File` / `sha256Hex` / `md5File` are exported. Direct `createHash` callers:

```
address-id/index.ts
ban/scripts/build-address-point-extract.ts      ┐ fileMD5 cloned between these two
ban/scripts/build-street-centroid-extract.ts    ┘
corpus/src/{adapter,parquet,split}.ts
filer/tools/linkage-corpus.ts
mailwoman/eval-harness/gauntlet/harness.ts
neural-weights-en-{gb,us}/scripts/link-dev-weights.ts   (see A1)
```

Check `address-id/index.ts` before changing it. The address primary key is a wire interface, and its
digest construction may be deliberate.

**Cost of leaving it: low.** **Cost of fixing it: low**, except `address-id`.

### A6. JSONL — `core/utils/jsonl.ts` exists; 10 files hand-roll split-and-parse

Nine files import `readJSONL`/`writeJSONL`/`iterateJSONL` correctly. Ten do not:
`corpus/src/golden.ts`, `corpus/src/extract-recipes/intersection.ts`,
`mailwoman/dev-tools/failure-report.run.ts`, `poi-taxonomy/scripts/generate-taxonomy.ts`,
`scripts/eval/postcode-anchor-accuracy.ts`, and five `corpus/src/**/*.test.ts` files.

These files drifted away from a home that was already known. About half of the JSONL readers use it.

**Cost of leaving it: low**, until a file needs the streaming `iterateJSONL` and grows a second
hand-rolled reader. **Cost of fixing it: low and mechanical.**

### A7. Data root — the `$MAILWOMAN_DATA_ROOT` literal is meant to live in exactly one file

`AGENTS.md`: "The lab `$MAILWOMAN_DATA_ROOT` default lives in **exactly one place**
(`data-root.ts`); never re-hardcode it in shipped code or scripts. In docs/comments/help-text
reference `$MAILWOMAN_DATA_ROOT` rather than the literal."

121 files use `dataRootPath`/`dataRootPath`, so most code follows the rule. These sites still contain the literal:

| kind      | site                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **code**  | `corpus/src/tools/extract-translit.ts:56,167`; `mailwoman/commands/corpus/extract/translit.tsx:26`                                                                                                                            |
| **tests** | `mailwoman/commands/geocode.test.ts:40,41`; `neural/fst-prior.test.ts:28`; `neural/placetype-pair-prior.test.ts:51`; `neural/test/capability-check.test.ts:36,37`                                                             |
| **prose** | `corpus/src/tools/corpus-stats.ts:35`; `corpus/src/tools/fetch/{index.ts:68,nad.ts:29,openaddresses.ts:47}`; `mailwoman/gazetteer-pipeline/postcode/zcta-centroids.ts:23`; `mailwoman/commands/corpus/extract/translit.tsx:9` |

The `extract-translit` pair matters most. There the literal is a **runtime default value**
(`options.legacyPathPrefix ?? "$MAILWOMAN_DATA_ROOT/"`), so a lab with a different data root
gets a silently wrong path rewrite.

**Cost of leaving it: low-medium.** One site is a real behavioural default, and the rest are in prose.
**Cost of fixing it: low, mechanical.**

### A8. String comparators — `@mailwoman/match` is the home; `jaccard` lives outside it ×3

`match/comparators.ts` exports `jaro`, `jaroWinkler`, `levenshteinSimilarity`, `nameSimilarity`. It
does not export `jaccard`, so three copies grew in `registry/tools`:

```
registry/tools/dedup-ceiling.ts:103          jaccard
registry/tools/gold-set-sample.ts:88         jaccard
registry/tools/nppes-dedup-benchmark.ts:186  orgJaccard
```

The same file pairs also clone `norm` (×2), `orgTokens` (×2), `addr` (×2), and `sigmoid` (×2).
`registry` already depends on `match`, so the problem is a missing export rather than a missing dependency.

**Cost of leaving it: medium.** `registry` is the record-matching app, and a comparator that disagrees
with the matcher's own comparators can produce wrong matches.
**Cost of fixing it: low.** Add `jaccard` to `match/comparators.ts` and repoint three sites.

## B — orphan duplication (each cluster names its proposed home)

### B1. Point-in-polygon — three implementations in three published packages

```
nuts-lookup/index.ts:37,54          pointInRing + pointInPolygon   (byte-identical to timezone-lookup)
timezone-lookup/index.ts:24,44      pointInRing + pointInPolygon
resolver-wof-sqlite/geo.ts:89,111   pointInRing + pointInPolygonRings  (readonly GeoJSON types)
```

`nuts-lookup` and `timezone-lookup` are byte-identical, `MultiPolygonCoords` type included.

`resolver-wof-sqlite/geo.ts:21-23` explicitly defers to spatial for distance:

> `haversineKm` is the canonical implementation in `@mailwoman/spatial`; re-exported so this package's
> callers have one import.

It then keeps its own point-in-polygon twenty lines below, because `@mailwoman/spatial` lacks
one. The author knew the rule and could not follow it for PIP.

**Proposed home:** `spatial/geometries/polygon.ts`. `AGENTS.md` already calls spatial "the math
home", and the missing PIP function makes that claim untrue.
**Cost of leaving it: medium.** Three packages carry ray-cast edge cases without shared tests.
**Cost of fixing it: low-medium.** The fix adds one export and changes three call sites, and the shared signature has to use the resolver variant's
`readonly` GeoJSON types.

> **Corrected on implementation.** Only the resolver moved. `nuts-lookup` and `timezone-lookup` each
> carry exactly one dependency (the zero-dependency `@mailwoman/annotations`). Importing spatial to reach the
> ray cast would pull `@mailwoman/core` and its ~11 MB of shipped data into two leaf packages. That
> is a weight increase of three orders of magnitude for fifteen lines, so both packages keep their copies, with the
> measurement recorded in place. The audit priced the duplication but not the dependency, and reading the
> dependency graph before moving the code caught the problem.

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
for ten corpus sources. Fixing a parsing edge case means finding all ten, and none of the copies refers
to the others.
**Cost of fixing it: lowest in the audit.** The fix is a mechanical extraction without any semantics to reconcile.
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

**Cost of leaving it: medium.** These helpers exist to match a Python original bit for bit. Each of the four copies
can drift from the reference, and the drift stays invisible until an extract differs.
**Cost of fixing it: low.** **Proposed home:** `core/utils/python-numeric.ts`, beside its siblings.

### B4. `splitCSV` ×6 in corpus extract recipes

Two variants, four copies and two copies:

```
corpus/src/extract-recipes/{fr-order:76, intersection:162, street-affix:137, unit:120}.ts   (variant 1)
corpus/src/extract-recipes/{german:47, po-box-cedex:220}.ts                                 (variant 2)
```

**Proposed home:** `corpus/src/extract-recipes/csv.ts`. Reconcile the two variants first, because their
behaviours differ in the split itself.
**Cost of leaving it: low-medium.** **Cost of fixing it: low.**

### B5. `swapDatabaseIntoPlace` ×2 — this is the documented build-then-swap rule

`mailwoman/commands/situs/address-points.tsx:85` and `…/interpolation-extract.tsx:148` are identical.
Each renames the live DB aside, clears `-wal`/`-shm`, renames the new DB into place, and deletes the old one.

This code implements the database rule from `AGENTS.md`:

> take care to build it successfully, then move the previous version to a temp directory, and then
> move the new version into place.

A rule the project states in prose and implements twice in code should be a function.

**Proposed home:** `core/utils/sealed-db.ts`. It already owns `sealDatabase` and
`openBuiltDatabase`, so it already handles the artifact lifecycle.
**Cost of leaving it: medium.** If one copy gets the `-wal` cleanup wrong, it corrupts a shipped
artifact. **Cost of fixing it: low.**

### B6. `v0-tree-adapter.ts` — a whole file duplicated, with a written exit plan nobody ran

`mailwoman/eval-harness/v0-tree-adapter.ts` and `scripts/eval/v0-tree-adapter.ts` differ in **four
docstring lines.** The code is identical. The docstrings describe which file is the copy:

> NOTE(phase5a): this is a COPY of `scripts/eval/v0-tree-adapter.ts` […] The original stays behind
> because two probes pending triage (`resolver-eval.ts`, `fr-admin-split-selfvalidation.ts`) still
> import it; the probe triage should delete that copy and repoint any survivor here.

The triage never happened. Both named probes still exist.

**Cost of leaving it: low today, and it is the cheapest cluster to close.**
**Cost of fixing it: low.** Triage the two probes and delete one file.

### B7. docs ↔ react component forks, after the port was called complete

Six components with the same names exist in both `docs/src/components/` and `react/`, and the copies have diverged:

| component              | docs | react | differing lines |
| ---------------------- | ---: | ----: | --------------: |
| `PipelineExplorer.tsx` |  292 |   161 |             399 |
| `ResultPanel.tsx`      |  233 |    98 |             281 |
| `POIExplorer.tsx`      |   80 |   143 |             185 |
| `LoadingIndicator.tsx` |  159 |   119 |             154 |
| `CandidatePicker.tsx`  |   40 |    45 |              45 |
| `KindBadge.tsx`        |   42 |    44 |              34 |

`KindBadge.stories.tsx`, `LoadingIndicator.stories.tsx`, and `styles.css` are also duplicated.

A full read of `KindBadge` shows the same markup tree, the same `formatPct` helper, and the same behaviour. The only real
differences are CSS-module class names versus BEM strings, and a locally imported `KindResult` type
versus react's structural `KindBadgeResult`. React's docstring says its copy is "Shared by
both explorers", but docs never adopted it.

Some docs components (`POIExplorer`, `PipelineExplorer`) do import `@mailwoman/react`, so the port is
partial.

**Cost of leaving it: medium.** A UI fix has to be made twice, and the two copies already
differ visibly in size.
**Cost of fixing it: medium.** It needs a decision on whether react's components take a className/theme
prop so that Docusaurus styling survives.

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

`codex` is the zero-runtime-dependency reference package, and its whole job is normalized reference data. Its three copies
of a name-folding function should be fixed first among these clusters.

### B9. Lexicon-normalization trio, copied as a group

`wordNorm` (×3), `isShortCode` (×3), `norm` (×2) across:

```
codex/tools/build-country-surface-lexicon.ts:74,81,86
mailwoman/commands/gazetteer/anchor-lexicon.tsx:64,74,79
mailwoman/gazetteer-pipeline/evidence-lexicons.ts:541,548
```

Three helpers copied together across three workspaces belong in one module that was never extracted.
**Proposed home:** `mailwoman/gazetteer-pipeline/lexicon-normalize.ts`, exported for `codex/tools`.

### B10. Drop-in API route plumbing

`legacyQuery` (`nominatim/routes.ts:75`, `photon/routes.ts:62`) and `errorContent`
(`libpostal/routes.ts:60`, `nominatim/routes.ts:123`). `api-kit` is the declared plumbing home and
all three packages already depend on it.
**Cost of fixing it: low.** The envelope _shapes_ must stay per-package (see rejected #5).

### B11. `registry/tools` has no shared module

Beyond A2/A8: `buildSpecs` ×3 (`coverage-reconciliation:95`, `cross-dataset-correlation:117`,
`cross-source-threshold-sweep:95`), `boundary` ×2, `mappingFor` ×2, `addr` ×2, four variants of `norm`.
The directory has twenty-four tool scripts and lacks a `registry/tools/shared.ts`.
**Cost of leaving it: low**, because these are tools rather than shipped runtime, **but new copies keep appearing here.**

### B12. Byte formatting ×4

> `humanBytes` ×2 (`corpus/src/tools/fetch/{openaddresses.ts:135, tiger-full.ts:80}`) and `iec` ×2
> (`corpus/src/tools/fetch/{ban.ts:162, state-hi-schools.ts:102}`) — two names, one job, four copies,
> all in the same directory. **Proposed home:** `corpus/src/tools/fetch/format.ts`.
> DONE. Moved to @mailwoman/core/fs/utils

### B13. `tiger/sdk` internal duplication

`downloadIfNeeded` ×2 and `runCapture` ×2 between `tiger/sdk/fetch.ts:172,187` and
`tiger/sdk/redistricting.ts:107,122`, which are adjacent files in the same package. This overlaps with A4. If these move
to `APIClient`, the duplicates disappear.

### B14. Test fixture builders rebuilt per file

`mailwoman/test-kit` exists, with 6 importers across 422 test files. These builders repeat:

```
resolver/*.test.ts        node ×6, localityOf ×3, makeBackend ×2, regionOf ×2
neural/*.test.ts          makePieces ×4
neural-web/*.test.ts      installMockSession ×2
{bdc,filer}/sdk/*.test.ts axiosLikeError ×2
react/map/*.test.tsx      settle ×2
mailwoman/test/*.test.ts  captureResolver ×2, weightsPresent ×2
corpus/src/*.test.ts      writeCSV ×2, baseRow ×2
```

The `resolver` cluster is worth extracting. It has six copies of a `node` fixture builder and three
of `localityOf` across six files that all test the same resolver.

**Cost of leaving it: low**, because test-local duplication is the cheapest kind.
**Cost of fixing it: low.** Do this one last.

## C — idiom drift

Four of the five conventions checked have **zero violations**:

- `erasableSyntaxOnly`: 0 `enum` and 0 runtime namespaces. The single `namespace NodeJS` hit is an
  ambient `.d.ts` declaration, which is permitted.
- Explicit `.ts` extensions on relative imports: 0 missing.
- Raw `process.env` / `process.argv` outside the approved modules: 0.
- The acronym pattern that `AGENTS.md` claims is at zero (`Json|Jsonl|Http|Api|Url|Uri` on exports): **0,
  so the claim is verified**.

### C1. Acronym casing — the swept list is clean, and new acronyms drifted in behind it

`AGENTS.md` (reconciled 2026-07-25) claims: "A grep for any **exported** lowercase-acronym identifier
(`Json|Jsonl|Us[A-Z]|Http|Api|Url`) across all published workspaces returns **zero**." That claim is
**true**. However, the sweep used a fixed list, and acronyms outside it drifted:

| acronym | house form (occurrences)                                                         | drifted exports                                                                                                                   |
| ------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POI     | `POI*` — `POILookup` ×81, `POISourceRow` ×26, `POIDatabase` ×26, `POIIntent` ×24 | `PoiBoard*` ×10 exports, `mailwoman/eval-harness/poi-board.ts:52,65,70,74,76,86,238,403,423,459`                                  |
| NZ      | upper 64 / lower 25                                                              | `Nz*` ×12 exports, `codex/nz/{delivery-service.ts:48,53,97,152,176,207,225,233, postcode.ts:26,36,46}`                            |
| NUTS    | upper 13 / lower 12                                                              | `annotations/index.ts:71 Nuts`, `nuts-lookup/build.ts:24 buildNutsDB`, `nuts-lookup/index.ts:93,132 NutsLookup/makeNutsAnnotator` |
| CRF     | upper 6 / lower 2                                                                | `neural/weights.ts:699,709 CrfTransitions/readCrfTransitions`                                                                     |
| GBT     | upper 2 / lower 0                                                                | `registry/learned-scorer.ts:133 createGbtScorer`                                                                                  |

**The clearest example is within one file.** `codex/nz/delivery-service.ts` declares
`NZ_DELIVERY_SERVICE_TYPES` at line 73 and `NzDeliveryServiceTypeName` at line 97. The same acronym
appears in two casings twenty-four lines apart.

**Why another sweep will not fix it.** `AGENTS.md` states: "There's no lint
rule for this (oxlint can't express it); it's reviewer discipline." When only review enforces a convention,
and sweeps check only a fixed acronym list, violations will keep appearing for every acronym missing from the
list. The durable fix is a CI check: a small script that checks exported identifiers against a project acronym
list. Another sweep would not last.

**Cost of leaving it: low** (cosmetic), **except for `POI`**, where the drift goes against 250+
occurrences of the opposite form in the same repo.
**Cost of fixing it: low** for `Poi`/`Crf`/`Gbt`, which are internal, so no public export moves. `Nz*` and
`Nuts*` are **public exports of published packages** (`@mailwoman/codex`, `@mailwoman/nuts-lookup`,
`@mailwoman/annotations`). Renaming them breaks consumers, so the renames belong in a major release, following the precedent
`AGENTS.md` records for the v5.0.0 batch.

## D — altitude (observation rather than a verdict)

I did not read each file, and a boundary finding requires that read. The table shows the size ranking,
with a quick characterization of each file's shape:

| file                                                  | lines | exports | fns | reading                             |
| ----------------------------------------------------- | ----: | ------: | --: | ----------------------------------- |
| `mailwoman/eval-harness/gauntlet/cases/regression.ts` |  2291 |       2 |   0 | case table — **not a finding**      |
| `mailwoman/eval-harness/oa-resolver-eval.ts`          |  1391 |       — |   — | eval harness                        |
| `neural/classifier.ts`                                |  1370 |       6 |   3 | few exports, coherent               |
| `resolver-wof-sqlite/lookup.ts`                       |  1315 |       4 |   0 | one large class                     |
| `filer/sdk/build-filer.ts`                            |  1293 |       4 |  18 | build script                        |
| `resolver/resolve.ts`                                 |  1145 |       1 |  15 | one entry point, 15 private helpers |
| **`mailwoman/geocode-core.ts`**                       |  1045 |  **17** |  11 | **the one worth a look**            |

`geocode-core.ts` is the outlier, with seventeen exported symbols and eleven functions in a thousand
lines. A broad exported surface suggests that a module serves several callers for
several reasons. **This is a prompt for a closer read rather than a finding.** Confirming it needs the per-file read I did
not do.

## Appendix — rejected candidates

Grep found each of these, and reading ruled each one out. They are recorded so that the next sweep does not propose
them again.

1. **`match/distance.ts:31 haversineKm`** is a documented adapter from
   `match`'s `LatLon` shape onto `spatial`'s scalar `haversineKm`, aliased on import as
   `greatCircleKm`. Its docstring says so. It is not a second implementation.

2. **The whole great-circle cluster.** Grep found lat/lon trigonometry in seven files outside
   `spatial/`. Reading showed that `resolver-wof-sqlite/geo.ts:23` **re-exports** spatial's function,
   `mailwoman/gazetteer-pipeline/postcode-locality/{base,jp,kr,tw}.ts` all **import** it (`base.ts:45`,
   `tw.ts:59`), and `match/distance.ts` is the adapter above. **The audit's first and
   most promising candidate set produced zero findings.**

3. **`resolver-wof-sqlite/street-centroid.ts:67 extentRadiusM`** contains haversine-shaped
   trigonometry, but it computes a bbox half-diagonal and uses `cos(midLat)²` where great-circle distance uses
   `cos(lat₁)·cos(lat₂)`. It is a deliberate variant for a different quantity rather than a copy.

4. **`api-kit/metrics.ts:52 percentile`** is a different function despite the name. It takes a
   **pre-sorted** array, returns `0` instead of `null` on empty input, and rounds to two decimals. It was written for a hot
   metrics path. Merging it into `core/utils/stats.ts` needs a judgment call about the interface, so it
   stays out of A2's mechanical sweep.

5. **`libpostal` / `nominatim` / `photon` error envelopes** have `{ error: "…" }` shapes that look like
   they should use `api-kit`'s `apiError`. They must not use it, because these are drop-in replacements and their
   wire shape is the upstream project's interface. `libpostal/app.ts:21` records the decision
   explicitly ("a recorded free choice, shaped to match"). Route _plumbing_ can still be shared
   (see B10).

6. **`registry/tools/dedup-ceiling.ts:272`, `cross-source-threshold-sweep.ts:355`, and
   `geocoder-vs-provided-coords.ts:81`** all alias or wrap `formatPercent`
   / `percentile` from `core/utils/stats`. They already use the home, but a `const pct =` grep flags them as copies.

7. **`docs/src/components/{SpanHighlight,TreeView,…} tier()` ×5** matched as a 5-copy clone group,
   but each copy already delegates to a shared `confidenceTier`. Only a two-line null check repeats,
   which is at best a marginal finding.

8. **`mailwoman/types/node.d.ts:7 namespace NodeJS`** is the only `namespace` in the repo, and it is allowed as
   an ambient declaration in a `.d.ts`, which `erasableSyntaxOnly` permits.

9. **Everything on the `AGENTS.md` "What deliberately stays raw" list**: `candidate-fts.ts:39`'s
   `CREATE VIRTUAL TABLE … USING fts5`, `coincident-roles.ts:205`, `build-slim.ts`'s
   introspect-and-replay, `zcta-centroids.ts`'s sync DDL, and the hot positional INSERT loops. These are documented
   decisions with stated reasons, and migrating any of them would make it worse.

10. **`gauntlet/cases/regression.ts` at 2291 lines** is a data table with two exports and zero
    functions. Its length alone does not show that it does more than one job.

11. **`nuts-lookup` / `timezone-lookup` point-in-ring, and `match/gbt.test.ts`'s LCG** are real,
    verified duplicates of code that now has a shared home, and they stay duplicated. Each package
    would have to take a dependency whose published weight is three orders of magnitude larger than
    the code it deduplicates (`@mailwoman/spatial` → `@mailwoman/core` → ~11 MB of data;
    `@mailwoman/match` has no core dependency at all today). Each file records this reasoning so that the next sweep
    finds it next to the copy. **A duplicate kept for a measured reason is a decision rather than a
    defect.** The audit's B axis lacked this category.

## What this audit did not cover

- `corpus-python`, which the charter puts out of scope.
- Bug hunting. Where duplicated code is also wrong, the defect is noted but not investigated.
- The per-file reads that axis D would need to produce verdicts rather than a flag.
- Clone detection hashed function bodies (`scripts/diagnostic/clone-scan.ts`, tracked as a keeper
  under the `.gitignore:169` rule because this document cites it). It extracts each function body by
  brace-matching, strips comments,
  collapses whitespace, replaces the declared name with a placeholder so that renamed copies still collide,
  and then hashes the result. It finds **identical** normalized bodies across files: 83 cross-file groups over 3,123
  units in 1,570 files. It cannot see near-duplicates that drifted by a line, so every count in
  this document is a floor rather than a ceiling. It also skipped bodies under four lines or 120 normalized characters,
  so trivial one-liner repeats are under-counted too.

## Appendix: the embedded-newline census (2026-08-03)

The CSV parse fix changes extract bytes only for a source that carries a newline inside a
quoted field. That can be measured, so we scanned every OpenAddresses
member reachable on the lab host for lines with an odd number of quotes:

| source            | member                |      lines | odd-quote | extract effect                          |
| ----------------- | --------------------- | ---------: | --------: | --------------------------------------- |
| `europe.zip`      | `fr/countrywide.csv`  | 25,414,422 |         2 | none — stride skips it                  |
| `europe.zip`      | `de/berlin.csv`       |    375,341 |         0 | none                                    |
| `europe.zip`      | `de/sn/statewide.csv` |    962,817 |         0 | none                                    |
| `ch__countrywide` | `ch/countrywide.csv`  |  2,759,182 |         0 | none                                    |
| `no__countrywide` | `no/countrywide.csv`  |  1,904,206 |         0 | none                                    |
| `it__countrywide` | `it/countrywide.csv`  |          — |         0 | none (equivalence-proven)               |
| `nl__countrywide` | `nl/countrywide.csv`  |          — |        >0 | none (equivalence-proven)               |
| `es__countrywide` | `es_addresses.csv`    | 15,627,792 |        52 | none — already correct since 2026-07-08 |

Two results matter.

**FR has exactly one such record**: `14ter,"Route de la Foret⏎route de la Foret",Biard,86580`, at
physical lines 22,849,586–87. Neither line is `≡ 3 (mod 211)`, so the `readFrTuples` stride skips both
halves and the extract is unchanged. That outcome is luck rather than design. The pre-filter hazard is
documented in place at `po-box-cedex.ts` instead of being fixed, because a halved record fails the field checks
and is dropped. The failure mode is therefore a lost row rather than a corrupt one.

**ES has the only real cluster, and it changes no result.** The 52 odd-quote lines are 26 records, all with the
same Catastro shape: a quoted field that holds only a newline, between the house number and the
postcode:

```
…,POL INDUSTRIAL VIAL B,"10",,
","16210","16042",Campillo de Altobuey,Cuenca,…
```

A quote-blind splitter turns each record into two rows, and the second row has `16210` one column off. However,
`locale.ts`, the only reader of `es_addresses.csv`, moved onto `CSVSpliterator` in
`1d7b1bd1` on **2026-07-08**, which is already on main, and `synth-es-pedania-v1.jsonl` was built on
**2026-07-22**. The extract postdates the fix by two weeks, so it already holds the corrected rows. It needs
neither a rebuild nor a re-pin.

**Corrected conclusion: no extract in the checkable set changes.** An earlier revision of
this appendix claimed that ES needed re-pinning. That claim came from finding the file that reads the ES CSV
and stopping there. It did not check whether that reader was on the changed code path (it is not,
because none of the eight `readCSVRecords` callers reads an ES source) or whether the artifact predated the fix (it
does not). Each check takes one command. The wrong claim would have cost someone an 800,000-row rebuild
before they found the fix was already in place.

**Still unscanned:** the seven `us__*` zips and the GeoNames dumps, which are absent from this host. The same
one-liner checks them:

```
unzip -p <zip> <csv> | awk '{n=gsub(/"/,"&"); if(n%2==1) odd++} END{print FILENAME, NR, odd+0}'
```

Zero means that recipe's extracts are untouched and need no attention. Nonzero means re-pin it.
