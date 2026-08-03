# Night-10 ship gate — Run B → v4.2.0 (2026-06-10)

The execution record for the fork decision (operator-deferred, recorded in
`2026-06-10-NIGHT-SHIFT-PLAN.md` §The decision): **re-baseline with reason + ship Run B
(`v1.0.2-consolidation-runB` @ step-020000) as v4.2.0, conditional on this gate.** All four
checks passed; the merge sequence and release followed. Training-gate numbers and the
capacity-wall evidence live in `2026-06-10-consolidation-session.md`; this doc is the SHIP
side only.

## Artifacts

- fp32 export: Modal `output-v101-runB-s42/model.onnx` (118.4 MB graph → 113 MB local)
- int8: `model-v102-runB-step-20000-int8.onnx`, **md5 `9eb4a99f6db06cccff57939f657c09f9`**,
  28.6 MB — quant verified deterministic (two runs, identical md5), pinned toolchain
- tokenizer: `v0.6.0-a0` (md5 `b6137e8c…`), unchanged

## The four checks

### 1. Honest-eval VT (resolver-coupled truth) — PASS

Same harness, same canonical DBs, 1428 held-out rows:

| model     | region-match | name-match |  coord p50 |  coord p90 | PIP (cov-adj) |
| --------- | -----------: | ---------: | ---------: | ---------: | ------------: |
| v4.1.0    |       100.0% |      93.8% |     3.4 km |     7.4 km |         47.1% |
| **Run B** |    **99.9%** |  **93.8%** | **3.4 km** | **7.4 km** |     **47.1%** |

The locality +12.9 / region +10.7 parse gains cost nothing downstream; the street −2.3 does
not propagate to coordinates. (Procedure note: this harness cannot feed the gazetteer
lexicon — Run B graded with zero-filled clues, a _degraded_ configuration vs what ships, so
this PASS is conservative.)

### 2. Demo presets — PASS

5/6 byte-identical to the live default; the 6th (`1060 W Addison St`) is the intended affix
split (`street_prefix=W, street=Addison, street_suffix=St`); the JSON fold recomposes for
libpostal-compat consumers.

### 3. int8 spot-check (gaz-fed) — PASS

| tag                                      |                      fp32 |        int8 |    Δ |
| ---------------------------------------- | ------------------------: | ----------: | ---: |
| country homograph                        |                      89.8 |        89.8 |  0.0 |
| street_prefix / suffix                   |               64.9 / 48.8 | 64.9 / 48.8 |  0.0 |
| unit                                     |                      90.6 |        90.6 |  0.0 |
| US postcode / street / locality / region | 97.3 / 76.2 / 72.9 / 89.1 |   identical | ≤0.1 |
| FR postcode / house_number               |               99.7 / 94.6 | 99.6 / 94.6 | ≤0.1 |

### 4. DE native order (int8) — PASS

Native-order locality 90.9% (bar ≥83.8); US/FR no-regression held (96.7 / 84.5).

## Arena refresh (scorecard lens 1 — NOT a gate; reported with caveats)

| arena             |   n |  v0 | v4.1.0 |   Run B | v0-only (B) |
| ----------------- | --: | --: | -----: | ------: | ----------: |
| libpostal (clean) |  69 | 29% |    22% |     19% |         17% |
| perturb (noisy)   | 398 | 39% |    60% | **58%** |          9% |
| postal (edge)     |  38 | 26% |    11% |      8% |         21% |

Run B dips 2–3pp whole-parse-strict vs v4.1.0. Two caveats, then the honest residue:
(a) `harness-v0-neural` cannot feed the gazetteer lexicon → Run B graded handicapped
(country emissions drop without clues; intl rows in the clean arena are country-bearing);
(b) the harness folds affixes correctly, so the split is NOT the cause. Residue: a real
small whole-parse cost consistent with the stated street/unit re-baselines. The noisy-arena
lead (the lens that matters for real traffic) holds at **+19pp over v0**. The grown
`v0-only` cells are exactly the arbitration layer's (#478) target — this is more headroom
for it, not a new problem. Follow-up filed to add gaz support to the arena harness for a
true-config measurement.

## Repairs finding (#486)

All per-tag gate numbers are **repairs-OFF** (`parse()` repairs are opt-in; the per-tag
harnesses never enable them). Run B clears postcode 97.3 and unit 90.6 unassisted. The
resolver path (repairs hardcoded ON) passed identically — repairs neither carry nor harm
this model. ON/OFF delta table rides #481.

## Verdict

**SHIP.** Merge sequence executed (#468 → #469 → #491, all verified; #466 closed). Release
steps and verification follow in the night-10 postmortem.
