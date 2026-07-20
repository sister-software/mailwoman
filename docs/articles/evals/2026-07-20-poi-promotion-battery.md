# `poiQueryKind` promotion battery — golden 2pp + demo presets + POI board

**Date:** 2026-07-20. **Flag:** `poiQueryKind` (`CreateRuntimePipelineOpts`, default OFF — see
[runtime-flag register](../plan/reference/runtime-flags.mdx)). **Status: report only.** No
default was flipped by this work; the numbers below are for the operator's promotion decision.

The register's gate: **"golden 2pp + demo presets + the POI board (spec §3.6)."** Three legs,
plus a report-only latency check the task also asked for.

## Leg 1 — golden 2pp guard (misroute count)

**Question:** does turning `poiQueryKind: true` on misroute real ADDRESS queries onto the poi
path?

**Method used: the DIRECT equivalent, not the full model-eval harness.** The golden-set runner
(`mailwoman/eval-harness/`, `promotion-gate.ts` and friends) is shaped around scoring the neural
classifier's tag output against golden components — parameterizing it by a pipeline-level routing
flag would mean threading `poiQueryKind` through the whole scorer for a question the harness
doesn't otherwise ask. `poiQueryKind` only changes Stage 2.5 (kind classification), so the direct
check runs every golden input through `normalize → computeQueryShape → detectLocale →
classifyKind`, comparing the flag-OFF classifier (`classifyKind`) against the flag-ON classifier
(`createKindClassifier({ poiLexicon: poiTaxonomyLookup })`, the exact wiring
`createRuntimePipeline` uses). A misroute is any input where the flag-ON top kind is
`"poi_query"`.

**Data:** golden v0.1.2, US + FR (`data/eval/golden/v0.1.2/{us,fr}.jsonl`) — 2,956 + 1,551 =
**4,507 entries**, matching the register's n≈4507.

**Result:**

```
total golden entries: 4507 (us=2956, fr=1551)
flag-ON top kind === "poi_query" (misroutes): 0
flag-ON top kind !== flag-OFF top kind (any delta, includes non-poi alternation): 0
```

**Zero misroutes, zero top-kind deltas of any kind** across all 4,507 golden address inputs.

**Harness sanity check:** to confirm this isn't a silently-broken lexicon lookup, the same
flag-ON classifier was run against known POI-shaped strings outside the golden set:

```
coffee near Springfield IL -> {"kind":"poi_query","confidence":0.9,...}
chevron near Houston       -> {"kind":"poi_query","confidence":0.9,...}
```

Both fire `poi_query` as the top kind, confirming `poiTaxonomyLookup` and the classifier wiring
are live — the golden-set zero is a real result, not a no-op harness.

Script: `scratchpad/poi-battery/leg1-golden-poi-misroute.ts` (gitignored, not committed —
reproducible from this doc's method description).

## Leg 2 — demo presets (byte-identity)

**Method:** the 6 demo presets from `mailwoman/eval-harness/preset-compare.ts` (`PRESETS`), run
through a flag-OFF `createRuntimePipeline({ classifier })` and a flag-ON
`createRuntimePipeline({ classifier, poiQueryKind: { poiDatabasePath: "/mnt/playpen/mailwoman-data/poi/poi-full.db" } })`
built from the **same classifier instance** (en-US weights, `NeuralAddressClassifier.loadFromWeights`).
Each preset's `PipelineResult` was diffed structurally, with the `timing` field (wall-clock
per-stage diagnostics, expected to vary run to run) excluded from the comparison — everything
else (tree, kind, locale, queryShape, normalized, poiIntent) was compared.

**Presets:**

- `1600 Pennsylvania Ave NW, Washington, DC 20500`
- `350 5th Ave, New York, NY 10118`
- `Pier 39, San Francisco, CA 94133`
- `1060 W Addison St, Chicago, IL 60613`
- `400 Broad St, Seattle, WA 98109`
- `90210`

**Result: all 6 byte-identical** flag-off vs flag-on (object form, live poi.db), no diffs of any
kind beyond the excluded `timing` field.

```
"1600 Pennsylvania Ave NW, Washington, DC 20500" — IDENTICAL
"350 5th Ave, New York, NY 10118" — IDENTICAL
"Pier 39, San Francisco, CA 94133" — IDENTICAL
"1060 W Addison St, Chicago, IL 60613" — IDENTICAL
"400 Broad St, Seattle, WA 98109" — IDENTICAL
"90210" — IDENTICAL
```

Script: `scratchpad/poi-battery/leg2-demo-presets.ts` (gitignored).

## Leg 3 — POI board

Already fresh; not re-run (would just re-derive numbers already committed 2026-07-20). Cited
from [`2026-07-20-poi-query-board-v1.1-brand-lexicon.md`](./2026-07-20-poi-query-board-v1.1-brand-lexicon.md):

```
POI query board (spec §3.6) — v1.1, REPORT-ONLY (no floors yet) — db: poi-full.db
51 cases, 92.2% overall pass rate

  expect kind     n     pass    rate
  abstain           8      8    100.0%
  address           6      6    100.0%
  results          37     33    89.2%
```

One open failure (`brand-us-02`, Applebee's/Dallas) traced to the reader's k-ring search radius
being tuned for category density, not brand density — not a subject-match or kind-classification
issue. See the v1.1 doc for the full trace.

## Latency (report-only, not part of the promotion gate)

**Question:** does the poi classifier's per-query lexicon scan add measurable overhead to a
plain address parse?

**Method:** 100 plain US address parses (golden `us.jsonl`, first 100 rows) through the same
flag-off/flag-on pipeline pair as leg 2, 10-call warmup excluded, `performance.now()` around each
call.

```
inputs: 100 (golden us.jsonl, first 100 rows)
flag-OFF: p50=3.804ms p95=4.632ms mean=3.935ms
flag-ON:  p50=3.549ms p95=3.933ms mean=3.616ms

delta p50: -0.255ms (-6.7%)
delta p95: -0.698ms (-15.1%)
delta mean: -0.319ms (-8.1%)
```

The delta is **negative** (flag-ON measured faster) in this run. A second pass with run order
swapped (flag-ON first) shows the same pattern reversed (whichever config runs second measures
faster), confirming this is JIT/cache warm-up ordering noise, not a real speed-up:

```
flag-ON (run 1st):  p50=3.695ms mean=3.734ms
flag-OFF (run 2nd): p50=3.466ms mean=3.607ms
```

**Conclusion: no detectable added latency from the poi classifier's lexicon scan at n=100** — any
true per-call cost is below the ~0.2–0.3ms run-to-run noise floor at this sample size. A larger-N
or dedicated microbenchmark would be needed to bound a true per-call cost below that floor; not
done here since the report-only ask was for a first-order signal, not a tight bound.

Scripts: `scratchpad/poi-battery/leg4-latency.ts`, `leg4-latency-swapped.ts` (gitignored).

## What the register's gate requires vs what was measured

The register: _"Promotion gate before any default flip: golden 2pp + demo presets + the POI
board (spec §3.6)."_

| Leg          | Requirement (as stated in the register)              | Measured                                                                                              |
| ------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Golden 2pp   | flag-on must not misroute/change real address parses | 0/4,507 misroutes, 0/4,507 top-kind deltas (direct classifyKind method, not the full scoring harness) |
| Demo presets | flag-on parses must match flag-off                   | 6/6 byte-identical (object form, live poi.db)                                                         |
| POI board    | spec §3.6 board passes                               | v1.1, 51 cases, 92.2% (8/8 abstain, 6/6 address, 33/37 results) — already committed, cited only       |

No recommendation is made here beyond these numbers — promotion is the operator's call.
