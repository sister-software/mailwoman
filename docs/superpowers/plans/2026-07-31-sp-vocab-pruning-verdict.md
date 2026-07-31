# SP vocabulary-pruning probe — VERDICT: NEGATIVE (premise falsified at measurement)

Task #25, closing the pre-registration
(`2026-07-31-sp-vocab-pruning-preregistration.md`). No artifact was built; the claim died at
step 1, before any bar ran.

## The measurement

Full v0.15.0-venue feed — **all 699 train shards, 684,103,970 rows, no sampling** — encoded with
the shipped v0.9.0-multisplice tokenizer, counted at the unit the model reads (`encode()` ids;
instrument: `corpus-python/scripts/measure_vocab_utilization.py`, ~12 min on 13 workers after the
bincount fix). Eval surface separately: 69,452 distinct texts → 13,348 fired ids.

**Fired: 63,101 / 73,143 = 86.27%** — versus the survey's "utilization ceiling 24%".

| band (fires over 684M rows) | pieces | share |
| --------------------------- | ------ | ----- |
| never                       | 10,042 | 13.7% |
| 1–9                         | 6,742  | 9.2%  |
| 10–99                       | 7,510  | 10.3% |
| 100–999                     | 27,208 | 37.2% |
| 1k–100k                     | 18,727 | 25.6% |
| 100k+                       | 2,914  | 4.0%  |

The pre-registered keep rule (fired ∪ eval-fired ∪ specials/byte-fallback ∪ single-codepoint)
keeps 63,608 (86.96%) → prunable: **9,535 rows = 3.7 MB** of the 28.1 MB int8 embedding table
(9.4% of the 39.4 MB artifact). The risk-accepting extension (also prune the 14,252
fired-1–99 "weak" pieces) would add 5.5 MB — and that band is practiced, so it is not free.

## Verdict

The lever as surveyed — "embedding is ~72.5% of params at ≤24% utilization" implying a
half-size-class prune — **does not exist**. 3.7 MB at the cost of a permanent id-remap coupling
between tokenizer.model and model.onnx (a new invariant surface every future fine-tune, splice,
and the browser loader must respect) is a bad trade. Not built, not shipped.

Provenance of the bad number: the 2026-07-30 synthesis line "(shipped-eval utilization ~6.7%,
ceiling 24%)" — the research agent's raw measurement basis wasn't committed, so it can't be
audited; plausibly a small sample or the 48k base vocab rather than the full 73,143-piece
spliced vocab against the full feed. The shipped-eval 6.7% figure is directionally consistent
with our narrower fixture-only sweep; the "ceiling" was not. **Lesson (standing): a survey
number that feeds a task list gets re-derived from primary data before the task spends real
effort — this probe's first step was exactly that, which is why it cost ~1 hour, not a build.**

## What survives

- The instruments: `measure_vocab_utilization.py` (fired counts over any manifest),
  `prune_vocab.py` + `verify_prune.py` (the surgery pair + B1/B2 bars — correct and reusable if
  a future vocab decision wants them).
- The telemetry: `$MAILWOMAN_DATA_ROOT/scratch-vocab-prune/utilization-v0150-venue.npz`
  (+ sidecar, eval-fired.json, eval-texts.json). Direct input to the CJK Phase-3 full-vocab
  rebuild and any v9 tokenizer-sizing decision — vocab right-sizing belongs at TOKENIZER
  TRAINING time (where the model learns whatever vocab exists), not post-hoc surgery.
- The 13.7% never-fired band is real but small; the 100–999 band (37.2%) says the mid-frequency
  tail is the vocab's working mass — an argument AGAINST aggressive vocab shrinkage in any
  future retrain, not just against this prune.
