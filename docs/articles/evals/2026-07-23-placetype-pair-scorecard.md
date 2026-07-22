# 2026-07-23 — placetype-pair-prior arc: ship-prep scorecard (Task 8)

Branch `feat/placetype-pair-prior` (unswitched throughout the arc). This is the ship-PREP
scorecard for Task 8 — no release was dispatched, nothing was promoted, no npm version was
bumped. It documents every number gating the decision, both checkpoints, and the one new
ship-blocking finding this task surfaced (the Gauntlet). Full battery/ablation source:
`.superpowers/sdd/task-7-report.md`; this task's own additions (Gauntlet, model cards, release
wiring): `.superpowers/sdd/task-8-prep-report.md`.

## Config-canonical bars (pre-registered, `v3.11.0-deploc-feed.yaml` header)

> PRIMARY : decode-layer dependent_locality emission MATERIALLY above probe-2 floors (NZ > 3/246,
> GB > 1/69) with tag-correct majority; raw-BIO emission + gap trajectory reported.
>
> GUARDS (each REGISTERED, none composite-maskable):
>
> - golden us micro within ±0.7pp of v385 (probe-2 missed by 0.1pp — must recover)
> - golden fr micro within ±0.7pp of v385
> - FR-fragment BARE-LOCALITY class ≥ 0.90 (v385 baseline 0.978; probe-2 collapsed to 0.603 — the
>   composite board number is NOT the bar; this class is)
> - digit board bare-street-hn flat vs 0.902 (probe-1/2 level; v385 fresh baseline 0.755)
> - 6 demo presets byte-identical to v385
> - val macro_f1 within 1.0pp of v385's 0.7047
>
> SHIP GATE: full error-analysis vs v385 — no tag regresses >2pp (config-canonical); gauntlet
> PASS. Ship path (HF upload → promote → npm CI → demo) is OPERATOR-AUTHORIZED for the 2026-07-22
> night shift CONDITIONAL on every bar above passing. Any bar fails → stage only, report, no
> promote (no silent gate drift; treadmill guard: no knob iteration).

## Digit gate revision (operator-ratified 2026-07-23, Teffen Ellis)

The pre-registered digit bar above (`flat vs 0.902`) was written against the sibling en-gb-locale
probe lineage's own 8k checkpoint (`v3.10.1-gb-probe2`) — a same-lineage probe number, not a real
ship baseline for a checkpoint forked from v385. That comparison is not apples-to-apples for
`v3.11.0-deploc-feed`, which forks from v385 (6.6.0) directly. The bar is **restated** against
v385's own fresh-measured baseline, taken in the same session on the same board:

|                                      |                                                        value |
| ------------------------------------ | -----------------------------------------------------------: |
| v385 fresh baseline (bare-street-hn) |                                                        0.755 |
| feed-8k (candidate)                  |                                         0.868 [0.831, 0.897] |
| Δ                                    |                                                  **+11.3pp** |
| old bar (0.902, probe-anchor)        | historical context only — CI excludes it, not the active bar |
| **result**                           |                        **PASS** (bar restated against 0.755) |

The 0.902 probe-anchor number is retained in this record as historical context; it is not the bar
this ship decision was graded against.

---

## Provenance block

| Artifact                                                | Path / identity                                     | md5                                | Notes                                                                |
| ------------------------------------------------------- | --------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| feed-2k checkpoint                                      | `v3.11.0-deploc-feed` step-002000                   | `fc7ad3cb1b8982eb047e8db40ab3f7f7` | 39,411,976 bytes                                                     |
| feed-8k checkpoint (SHIP CHECKPOINT, operator-ratified) | `v3.11.0-deploc-feed` step-008000                   | `7f75fc449d8abcaa06fb6d4a5502ced7` | 39,411,976 bytes                                                     |
| v385 (shipped baseline, 6.6.0)                          | `model-v385-latam-step-008000-int8.onnx`            | `700f3cf4c08f31536f0bc053c281b19e` | dereferenced from the real shipped `neural-weights-en-us/model.onnx` |
| Tokenizer                                               | `v0.9.0-multisplice/tokenizer.model`                | `5c01cdcd4ae25849c5cb26b69fd3dde9` | byte-identical across all three, no tokenizer change                 |
| PPD source CSV                                          | `$MAILWOMAN_DATA_ROOT/ppd/2026-07-22/gb-tuples.csv` | `dbd675bdc970ea60f96f0a470429a128` | 25,674,048 rows                                                      |
| `pair-index-gb.bin` (shipped artifact)                  | `neural-weights-en-gb/pair-index-gb.bin`            | header `delta: 5.0`                | 19,209 pairs, 457,842 bytes — matches feed-8k's calibrated δ         |
| Model card                                              | `neural-weights-en-us/model-card.json` v6.7.0       | `num_labels: 33` (STAGE3)          | labels unchanged from 6.6.0                                          |

**Probe mode:** `"segment"` throughout (the library default since `d2a1242f`) — every board below
uses the shared, un-overridden default.

---

## Full battery — both checkpoints

No dropped failing rows: feed-2k's FR-fragment `bare-locality` FAIL stays in this table exactly
as measured.

### Golden us/fr micro-F1 (v385 fresh baseline, same session)

| Locale      | v385 (fresh) | feed-2k |                                     Δ | feed-8k |                                     Δ |
| ----------- | -----------: | ------: | ------------------------------------: | ------: | ------------------------------------: |
| us micro-F1 |        86.7% |   86.1% |            −0.6pp (within ±0.7, PASS) |   86.2% |            −0.5pp (within ±0.7, PASS) |
| fr micro-F1 |        89.9% |   90.8% | +0.9pp (outside magnitude, favorable) |   91.1% | +1.2pp (outside magnitude, favorable) |

### FR-fragment `bare-locality` ≥ 0.90

|                     |        v385 (fresh) |                        feed-2k |                    feed-8k |
| ------------------- | ------------------: | -----------------------------: | -------------------------: |
| bare-locality       | 0.983 [0.964,0.991] | **0.665 [0.617,0.709] — FAIL** | 0.988 [0.971,0.995] — PASS |
| OVERALL (composite) | 0.676 [0.659,0.693] |            0.780 [0.764,0.795] |        0.745 [0.729,0.761] |

feed-2k fails this bar **outright** — a 400-row board, CI entirely below 0.90. Not a marginal
miss: a hallucinated-street regression, the same shape as the sibling en-gb-locale-arc's own
probe-2 checkpoint at its equivalent step (bare-locality collapsed 0.978→0.603 there too). feed-8k
avoids it and beats v385's own 0.983.

### Digit board `bare-street-hn` — see the gate-revision block above

|                                         |              feed-2k |              feed-8k |
| --------------------------------------- | -------------------: | -------------------: |
| bare-street-hn                          | 0.890 [0.856, 0.917] | 0.868 [0.831, 0.897] |
| flat vs the RETIRED 0.902 probe-anchor? | YES (CI brackets it) |  NO (CI excludes it) |
| vs the REVISED bar (v385 fresh 0.755)   |              +13.5pp |   **+11.3pp — PASS** |
| OVERALL                                 |  0.915 [0.903,0.926] |  0.907 [0.895,0.918] |

feed-8k's 0.868 independently reproduced across two separate grading sessions (Task 7 and Task 8),
cross-validating the harness.

### val macro_f1 (±1.0pp of v385's 0.7047)

- **feed-8k: 0.7176** (coordinator-reported, cross-confirmed live). Δ = **+1.29pp** — outside the
  literal magnitude, favorable direction.
- **feed-2k: unrecoverable.** Modal's log retention had already truncated the step-2000 eval by
  the time Task 7 queried it; no other doc in this repo records this run's own step-2000 number.
  Open item for the operator if this matters to the promotion decision.

### Four dependent_locality boards, full pipeline

`gb-golden` via en-gb weights + prior ON @ δ\*; `nz-suburb-golden`/`es-pedania-golden`/`fr-lieudit-golden`
via en-us control weights (no prior possible for these three — they measure the checkpoint's own
multi-locale resurrection, the actual reason these shards were fed into this training run).

| Board                                      |   n | feed-2k emit/tag-correct                | feed-8k emit/tag-correct                |
| ------------------------------------------ | --: | --------------------------------------- | --------------------------------------- |
| gb-golden (prior ON @ δ\*)                 |  69 | 69/69, **67/69 (97.1%)**                | 69/69, **67/69 (97.1%)**                |
| gb-golden, comma-stripped (prior ON @ δ\*) |  69 | 0/69, 0/69 (inert, documented v1 trade) | 0/69, 0/69 (inert, documented v1 trade) |
| nz-suburb-golden (checkpoint only)         | 246 | 0/246, 0/246                            | 0/246, 0/246                            |
| es-pedania-golden (checkpoint only)        |  65 | 11/65, **9/65 (13.8%)**                 | 9/65, **7/65 (10.8%)**                  |
| fr-lieudit-golden (checkpoint only)        |  80 | 0/80, 0/80                              | 2/80, **1/80 (1.25%)**                  |

**GB recall is tied between checkpoints (67/69 both)** — the same two rows miss under both
(`"Goulbourne Road, St Georges, Telford, TF2 9LE"` — word-boundary, wrong-value; and `"101
Coniston Avenue, Knott End on Sea, Poulton-le-Fylde"` — pre-existing model-level miss). This is
the arc's central structural finding: **the pair-index prior, not the checkpoint's own
resurrected classifier row, carries nearly all of GB's dependent_locality recall** — see the
ablation table below. NZ shows **zero** decode-layer recovery at either checkpoint, despite being
the arc's original target locale (the sibling en-gb-locale-arc's independent checkpoint sweep
found the same shape: a hot-classifier-LR resurrection window that peaks near step 2000 and
re-buries the tag by step 8000 — `docs/articles/evals/2026-07-22-night-en-gb-postmortem.md`).

### Venue-confound FP @ δ\*

|         | δ\* | FP      |    FP% |
| ------- | --: | ------- | -----: |
| feed-2k | 4.5 | 37/6500 | 0.569% |
| feed-8k | 5.0 | 48/6500 | 0.738% |

Both well under the retired δ=6.0 working number (122/6,500, 1.877%). Not the pre-registered FP=0
bar — the residual is a single, honestly-characterized class (a venue that IS, verbatim, its own
bare census child) — but substantially smaller than what was previously shipped as the working
number.

### δ-sweep (both checkpoints, holdout tag-correct recall n=653 / venue-confound FP n=6500)

**feed-2k:**

|                  δ | holdout tag-correct | confound FP% |
| -----------------: | ------------------: | -----------: |
|                  3 |               75.7% |       0.215% |
|                  4 |               93.3% |       0.369% |
| **4.5 (selected)** |           **96.2%** |   **0.569%** |
|                  5 |               97.7% |       0.954% |
|                  6 |               98.9% |       1.877% |
|                  7 |               99.2% |       2.092% |

**feed-8k:**

|                                    δ | holdout tag-correct | confound FP% |
| -----------------------------------: | ------------------: | -----------: |
|                                    3 |               56.0% |       0.215% |
|                                    4 |               87.9% |       0.323% |
|                                  4.5 |               93.4% |       0.523% |
| **5.0 (selected, shipped artifact)** |           **96.3%** |   **0.738%** |
|                                    6 |               98.2% |       1.646% |
|                                    7 |               98.9% |       2.062% |

FP grows **monotonically** with δ for both checkpoints (roughly 6–10× from δ=3 to δ=7) — δ is a
genuine recall/FP dial, not a free lunch; the smallest δ clearing the recall bar is load-bearing.

### 6 demo presets

Both checkpoints, both weights worlds (en-us control path AND en-gb weights with the prior ON @
δ\*), all 6 presets, vs the fresh v385-en-us baseline: **ALL byte-identical, every combination.**

### Full error-analysis vs v385, per tag (2pp rule)

| Tag                |              v385 |           feed-2k |        Δ |           feed-8k |        Δ |
| ------------------ | ----------------: | ----------------: | -------: | ----------------: | -------: |
| locality           |             48.6% |             49.7% |     +1.1 |             50.1% |     +1.5 |
| region             |             78.1% |             79.1% |     +1.0 |             80.1% |     +2.0 |
| postcode           |             97.4% |             97.9% |     +0.5 |             97.8% |     +0.4 |
| street             |             15.4% |             14.6% |     −0.8 |             13.9% | **−1.5** |
| house_number       |             97.0% |             97.4% |     +0.4 |             96.7% |     −0.3 |
| venue              |             37.1% |             35.4% | **−1.7** |             36.0% |     −1.1 |
| country            |             89.8% |             94.3% |     +4.5 |             94.3% |     +4.5 |
| dependent_locality |              0.0% |              0.0% |      0.0 |              0.0% |      0.0 |
| po_box             |             88.9% |             88.9% |      0.0 |             88.9% |      0.0 |
| **Exact-match**    | 1150/4561 (25.2%) | 1152/4561 (25.3%) |  +0.02pp | 1147/4561 (25.1%) |  −0.07pp |

Worst mover: feed-2k venue −1.7pp; feed-8k street −1.5pp. **No tag regresses >2pp for either
checkpoint** — both PASS this leg cleanly.

---

## Three-way ablation (GB dependent_locality, full pipeline)

| Condition                                      |                       GB emit/tag-correct | Notes                                                                                |
| ---------------------------------------------- | ----------------------------------------: | ------------------------------------------------------------------------------------ |
| v385 (pre-feed) + prior @ δ=6 (rung-3 control) |                                      3/69 | weights matter — even the un-fine-tuned base gets a little lift from the prior alone |
| feed (either checkpoint) + prior OFF           |                                      0/69 | prior matters — the fine-tune's own resurrection is invisible at decode without it   |
| feed (either checkpoint) + prior ON @ δ\*      | 69/69 emit, **67/69 (97.1%) tag-correct** | together: +67pp over either ingredient alone                                         |

Each ingredient is provably necessary; the fine-tune's resurrection puts the tag within δ of
winning, the prior supplies the calibrated final push. Neither alone reaches production-usable
recall.

---

## Gauntlet — NEW finding, Task 8, 2026-07-23

Not run by Task 6 or Task 7; this task closed that gap and found a real ship blocker.

| Layer           | feed-8k verdict        | Detail                                                                                                                                                                                                                                        |
| --------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| regression      | PASS                   | 33/33 gated cases; 1 tracked known_fail now passes (should be promoted to `status=pass`)                                                                                                                                                      |
| **metamorphic** | **FAIL**               | NEW violation: `INV[comma-drop]` — `"1600 Pennsylvania Ave NW, Washington DC 20500"` → comma-dropped form loses the rooftop resolution entirely (38.8977,-77.0365 → **0,0**). v385 HOLDS this exact case (confirmed same session, same board) |
| held-out        | PASS                   | z=0.00 (candidate not significantly worse), n=300 fresh FR/BAN draw                                                                                                                                                                           |
| **combined**    | **FAIL — do not ship** | per the recipe's own pre-registered ship gate                                                                                                                                                                                                 |

**This is not checkpoint-specific.** feed-2k independently FAILS the same layer with DIFFERENT
violations: `BAND[num-ordinal]` and `INV[comma-drop]`/`INV[abbrev]` all mis-resolve `"350 Fifth
Avenue, New York, NY"` 283.5km away (a different state entirely). Two different checkpoints from
the same training lineage, two different NY/DC-class admin-resolution robustness regressions — the
pattern reads as a lineage-wide `v3.11.0-deploc-feed` cost, not a single-step artifact. Full
transcripts: `.superpowers/sdd/task-8-prep-report.md`.

**Ship-checkpoint choice is unaffected by this finding** — the operator-ratified reasoning
(feed-2k's FR-fragment failure is the more dangerous, unbounded class; feed-8k's digit miss is
narrower and now covered by the gate revision) stands regardless of which checkpoint also happens
to fail the Gauntlet. Both do. The Gauntlet failure blocks promotion of **either** checkpoint until
triaged — it is a new, independent finding layered on top of the existing checkpoint decision, not
a tiebreaker between the two.

---

## Coverage numbers

| Locale/board                       |                                     Rows | Source                                                                                |
| ---------------------------------- | ---------------------------------------: | ------------------------------------------------------------------------------------- |
| GB held-out (δ-calibration)        |                                    2,000 | PPD tail, disjoint from `synth-gb-v1` (800k) + `gb-golden`/`gb-venue-confound` boards |
| GB venue-confound                  |                                    6,500 | FSA-sampled                                                                           |
| gb-golden                          |         120 total, 69 dependent_locality | `mailwoman/eval-harness/fixtures/gb-golden.jsonl`                                     |
| nz-suburb-golden                   |                   246 dependent_locality | promoted NZ suburb board                                                              |
| es-pedania-golden                  |                    65 dependent_locality |                                                                                       |
| fr-lieudit-golden                  |                    80 dependent_locality |                                                                                       |
| synth-gb-v1 training shard         | 800,000 rows, 32.8% B-dependent_locality | HM Land Registry PPD (OGL v3.0)                                                       |
| synth-nz-v2 training shard         |              800,000 rows, 79.2% density | LINZ-derived OpenAddresses NZ (CC-BY 4.0)                                             |
| synth-es-pedania-v1 training shard |              800,000 rows, 30.3% density | OpenAddresses ES (CC-BY per OA source)                                                |
| synth-fr-lieudit-v1 training shard |   100% density (every row is a lieu-dit) | BAN `nom_ld` (Licence Ouverte 2.0)                                                    |

---

## Decision matrix (carried from Task 7, Gauntlet row added)

| Bar                                                    | feed-2k                                                                                                      | feed-8k                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Golden us micro ±0.7pp of v385                         | PASS (−0.6pp)                                                                                                | PASS (−0.5pp)                                                                                     |
| Golden fr micro ±0.7pp of v385                         | outside magnitude, favorable (+0.9pp)                                                                        | outside magnitude, favorable (+1.2pp)                                                             |
| FR-fragment `bare-locality` ≥ 0.90                     | **FAIL (0.665)**                                                                                             | **PASS (0.988)**                                                                                  |
| Digit `bare-street-hn`, revised bar (v385 fresh 0.755) | PASS (+13.5pp)                                                                                               | PASS (+11.3pp)                                                                                    |
| val macro_f1 ±1.0pp of 0.7047                          | unmeasurable (log truncated)                                                                                 | ambiguous magnitude, favorable direction (+1.29pp)                                                |
| GB dep-loc, full pipeline, prior ON @ δ\*              | PASS (67/69, 97.1%) — tie                                                                                    | PASS (67/69, 97.1%) — tie                                                                         |
| GB dep-loc, comma-stripped                             | inert (0/69, documented v1 trade) — tie                                                                      | inert (0/69, documented v1 trade) — tie                                                           |
| NZ dep-loc (checkpoint only)                           | 0/246 — tie                                                                                                  | 0/246 — tie                                                                                       |
| ES dep-loc (checkpoint only)                           | 9/65 (13.8%)                                                                                                 | 7/65 (10.8%) — feed-2k ahead                                                                      |
| FR-lieudit dep-loc (checkpoint only)                   | 0/80                                                                                                         | 1/80 (1.25%) — feed-8k ahead                                                                      |
| Venue-confound FP @ own δ\*                            | 0.569% (37/6500)                                                                                             | 0.738% (48/6500) — feed-2k lower                                                                  |
| 6 demo presets byte-identical (both weights worlds)    | PASS                                                                                                         | PASS                                                                                              |
| Error-analysis, no tag >2pp                            | PASS (worst venue −1.7pp)                                                                                    | PASS (worst street −1.5pp)                                                                        |
| **Gauntlet (NEW, Task 8)**                             | **FAIL** (`BAND[num-ordinal]`/`INV[comma-drop]`/`INV[abbrev]`, "350 Fifth Avenue, New York, NY" 283.5km off) | **FAIL** (`INV[comma-drop]`, "1600 Pennsylvania Ave NW, Washington DC 20500" loses rooftop → 0,0) |

**Ship checkpoint (operator-ratified 2026-07-23): feed-8k.** Reasoning carried from Task 7 — the
FR-fragment miss is the more dangerous failure class (fires on any bare-locality input, any
locale), while feed-8k's digit miss is narrower and now clears the revised bar. GB dep-loc recall
doesn't differentiate the checkpoints (the prior carries it, not either checkpoint). **Promotion
itself remains blocked** — not by the checkpoint choice, but by the Gauntlet finding above, which
applies to both candidates and was not part of the original six pre-registered guards.

---

## Open items for the operator

- **The Gauntlet metamorphic-layer regression is unresolved.** Both checkpoints fail it, with
  different specific violations. This blocks promotion of either one until triaged — root-causing
  it is out of this task's scope (ship-prep, not model debugging).
- **val macro_f1 for feed-2k remains unrecoverable** from any log or doc found.
- **`neural-weights-en-gb` has not shipped to npm.** This entire arc, prior included, is
  pre-promotion; the `runtime-flags.mdx` `placetypePair` row stays Default-OFF.
- If the operator ultimately promotes feed-2k instead of feed-8k, the shipped `pair-index-gb.bin`
  must be rebuilt at `--delta 4.5` and `neural-weights-en-gb/scripts/link-dev-weights.ts`'s
  `PAIR_INDEX_DELTA` flipped back down (both one-line changes, documented inline in that file).
