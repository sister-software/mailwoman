# v8-jp-full 24k: the JP char model clears its pre-registered gate

**Date:** 2026-08-05 · **Run:** `v8-jp-full` seed 42, 24,000 steps on Modal (app `ap-sQNIbzfiHx5OgmG8iG8Xa8`) · **Arc:** CJK Phase 3/4 (#1176) · **Status:** GATE PASS

The scorer and bar were pre-registered on #1176 (2026-07-29, scorer pinned at `34c7b6c2`): blended
coordinate-acceptability ≥ 0.70 at 15 km on the held-out 20,000-row board, scored with
`corpus-python/scripts/score_jp_probe_board.py --label-set stage3-jp`. The board holds out whole
municipalities (the probe's bucket rule), so nothing on it was seen in training.

---

## 1. Headline

|                                     |                               |
| ----------------------------------- | ----------------------------- |
| **Coordinate-acceptability @15 km** | **0.9928** (19,855 / 20,000)  |
| Pre-registered bar                  | ≥ 0.70                        |
| Unresolved (pred pair not in table) | 114 / 20,000                  |
| Final val loss / macro-F1           | 0.6966 / 0.9999 (20,000 rows) |

The bar was set from Leg-1's 200k-row probe (0.9925 on 33 labels); the full model matches it on a
10× corpus with the 47-label `stage3-jp` head — 2,000,000 train rows, char vocab 2,237, from
scratch, 3.07 epochs, ~80 min at ~5 steps/s.

## 2. Per-register acceptability (diagnostic, not the gate)

| register       | @15 km                 | unresolved |
| -------------- | ---------------------- | ---------- |
| native         | 0.9921 (13,747/13,857) | 86         |
| designator     | 0.9932 (4,953/4,987)   | 28         |
| arabic_chome   | 0.9984 (611/612)       | 0          |
| compact_folded | 1.0000 (544/544)       | 0          |

The register-mix question the operator closed as keep-as-built (only 14.66% of rows can render the
synthetic registers) reads clean here: every register clears 0.99, so the mix needs no revisiting.

## 3. Per-tag span exact-match

| tag             | exact  |     | tag          | exact  |
| --------------- | ------ | --- | ------------ | ------ |
| prefecture      | 1.0000 |     | municipality | 0.9943 |
| postcode        | 1.0000 |     | district     | 0.9869 |
| country         | 1.0000 |     | sub_block    | 0.9954 |
| block           | 1.0000 |     | house_number | 0.9925 |
| building_number | 1.0000 |     |              |        |

## 4. The 2k probe, in hindsight

The probe read 0.2237 blended with municipality span exact-match at 0.1847 — and was judged sane
rather than fatal because its cosine fully anneals inside 2,000 steps (the probe recipe's own
documented deviation) and municipality was the known bottleneck at that exposure. The judgment
held: the same head at 24k reads municipality 0.9943. The probe's four mechanical questions all
answered yes (head loads/saves on the char path, `[classifier_learning_rate] 18,095 params @ 0.001`
printed, supported labels separated, scorer ran end to end) — which is all a probe is for.

## 5. What this does NOT decide

- Shipping. This is a training-gate record, not a release: the JP model has no serving path yet
  (char-path inference, weights packaging, and the `ja-jp` overlay are the next arc). The ledger
  keys by shipped npm model versions and does not take this row.
- The head-LR change (`classifier_learning_rate: 1e-3`, a 2× head/body ratio). The run converged
  with it; nothing here isolates its contribution. The A/B the probe config describes (delete the
  key, diff per-label F1) remains unrun and optional.

Checkpoint: `$MAILWOMAN_DATA_ROOT/models/v8-jp-full-s42/step-024000/` (pulled from
`/data/output-v8-jp-full-s42/step-024000`; intermediate saves at 4k/8k/12k/16k/20k stay on the
volume). Train log: `output-v8-jp-full-s42/train_log.csv`.
