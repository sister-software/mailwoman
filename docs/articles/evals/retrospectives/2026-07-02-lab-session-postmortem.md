# 2026-07-02 — lab session postmortem: #884 ship evidence + the #885 measurement re-anchor

Lab session off `HANDOFF-825-rev.md` (the re-railing sprint's Tracks 2 + 4 lab slice). CPU-only
as briefed; one Modal call (int8 quantize, ~seconds); no training, no promotion.

## What shipped

- **PR #889 (`feat/825-v196-slavic-anchor`)** — the #884 ship-prep branch: CZ/PL coord eval sets
  at n=1k (new `--reservoir` sampling on `build-oa-coord-golden.ts`, default path byte-identical),
  `coord-eyeball --cand-tokenizer`, `wasm-latency-probe.ts`, plus the pre-session splice pipeline.
- **PR #888 (`feat/885-measurement-reanchor`)** — `parity-scorecard-2026-07-02.md` (first full
  per-tag re-score since 06-11: **17/17 floors PASS** on the shipped 5.0.0 bytes, md5-verified
  against the published npm tarball), releases.mdx brought current from "4.11.0 (current)" to
  5.0.0, status.mdx re-verified, F1ScoreTable +v4.4.0/+v5.0.0 columns.
- **#884 comments**: n=1k gate results, int8 + browser-budget numbers, and the **#295 promotion
  brief** (GO recommendation, one operator decision open).
- **#887 filed**: de-order-eval's anchor-OFF ablation broken by the #718 fail-closed gate.

## The numbers

| gate (pre-registered before each measurement) | result                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| US-2k ni, int8 feed parity                    | PASS — candidate row dump **byte-identical** to shipped v193a3 int8         |
| CZ-1k improve                                 | PASS — wrong-city 22.4→14.8% (CI [−10.3,−5.1]pp), resolved-p50 3.29→2.73 km |
| PL-1k improve                                 | PASS — wrong-city 27.9→7.9% (CI [−22.7,−17.4]pp), resolved-p50 2.07→1.33 km |
| int8 size                                     | 33.8 MB, **+3.8 MB over the ~30 MB browser SLO** (operator fallback call)   |
| WASM latency (Node, 1-thread bound)           | flat ~41–44 ms p50/p95 both models; load 66→85 ms                           |
| #885 re-score                                 | 17/17 floors PASS; fp32↔int8 max delta 0.8pp                                |

## What went well

- **Pre-register → measure → verify-before-verdict, three times.** The CZ churn eyeball (43
  newly-wrong rows) turned an aggregate win into a mechanism: candidate parses are structurally
  better; the flips are a pre-existing locality-truncation→namesake residual the baseline won by
  fluke. That nuance is now in the promote record instead of surfacing post-ship.
- **The int8 U.S. result is the strongest possible form** — byte-identical row dumps, not just
  CI-bounded non-inferiority. The embedding-growth quantization-scale worry was pre-registered
  and measured dead.
- **Salvage-first held**: every grading tool existed; the only new code is two small flags and
  one probe.

## What could have gone better

- **I drafted two arena cells from a spec comment before reading the measured output** (libpostal
  41→actual 30, postal 32→actual 24). Caught in-session by checking `verdict.json` + the results
  JSON before commit — but the draft should never have contained unmeasured numbers.
- The handoff's issue numbers (#291/#293/#295/#296) don't exist as GitHub issues — they're the
  #884 checklist items. Deliverables were posted to #884/#885 instead; future handoffs should
  carry real issue links.
- `onnxruntime-web` in Node took four iterations to run (fetch → blob → http-scheme ESM refusals);
  the working recipe (file:-URL `{mjs,wasm}` pair + `numThreads=1`) is now encoded in the probe.

## Decisions made autonomously

- Added `--reservoir` to the eval-set builder rather than shipping head-fill 1k sets: head-fill
  gave ~1 municipality per bucket (CZ file head: 2 cities in 4k rows), which under-disperses the
  exact metric (wrong-city%) the sets exist to power. Default path proven byte-identical.
- Graded the shipped int8 as the #885 artifact (with fp32 delta legs) and md5-verified it against
  the published npm tarball first — treating "the shipped line" as bytes, not a version label.
- Framed the browser-SLO breach, ledger fate, and re-score cadence as operator decisions
  (review addendum Track 3) — evidence supplied, no bar moved.

## Open questions for the operator

1. **#295 go/no-go** — the brief on #884 recommends GO once the int8 budget question is answered
   (prune / server-only / accept the +3.8 MB).
2. **Ledger fate** (#885) — repopulate `scores-by-version.json` from this scorecard vs deprecate.
3. **Re-score cadence rule** for CONTRIBUTING_MODEL_WORK.mdx — proposal in the scorecard.
4. `fr.cedex_real` 96.1→89.4 drift — diagnose or accept (19pp above floor today).

## Concrete next steps

- Merge order: **PR #888 (baseline) → PR #889 (ship prep)** → operator answers the SLO question →
  release-prep PR (model-card: new `tokenizer_version`, OA CZ/PL attribution) → `mailwoman-release`.
- #887 is a bounded night-shift chore (wire `overrides.anchor=false` through `oa-resolver-eval`).
- #296-residual: CZ 14.8%/PL 7.9% wrong-city is decode-boundary/namesake + coverage now — name-key
  or span levers, not vocab.

## Ledger

|                     |                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Session             | Lab, 2026-07-02, ~00:30–01:45 UTC                                                             |
| Models trained      | 0                                                                                             |
| Modal spend         | 1 quantize call (~seconds of CPU)                                                             |
| Promotions          | 0 (by design — #295 is operator-gated)                                                        |
| Regressions shipped | 0                                                                                             |
| PRs opened          | #888, #889                                                                                    |
| Issues filed        | #887                                                                                          |
| Gates run           | 3 pre-registered batteries (n=1k CZ/PL fp32, int8 feed-parity, #885 full re-score) — all PASS |
