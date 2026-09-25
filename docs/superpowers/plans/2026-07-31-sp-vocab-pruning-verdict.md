# SP vocabulary-pruning probe — VERDICT: NEGATIVE (premise falsified at measurement)

This record closes task #25 and its pre-registration
(`2026-07-31-sp-vocab-pruning-preregistration.md`). No artifact was built. Step 1 falsified the
claim before any bar ran.

## The measurement

The full v0.15.0-venue feed (**all 699 train extracts, 684,103,970 rows, without sampling**) was encoded
with the shipped v0.9.0-multisplice tokenizer. Counts were taken at the unit the model reads
(`encode()` ids) with `corpus-python/scripts/measure_vocab_utilization.py`, which took about 12
minutes on 13 workers after the bincount fix. The eval surface was measured separately: 69,452
distinct texts fired 13,348 ids.

**Fired: 63,101 / 73,143 = 86.27%.** The survey had claimed a "utilization ceiling 24%".

| band (fires over 684M rows) | pieces | share |
| --------------------------- | ------ | ----- |
| never                       | 10,042 | 13.7% |
| 1–9                         | 6,742  | 9.2%  |
| 10–99                       | 7,510  | 10.3% |
| 100–999                     | 27,208 | 37.2% |
| 1k–100k                     | 18,727 | 25.6% |
| 100k+                       | 2,914  | 4.0%  |

The pre-registered keep rule (fired ∪ eval-fired ∪ specials/byte-fallback ∪ single-codepoint)
keeps 63,608 pieces (86.96%). The prunable remainder is **9,535 rows = 3.7 MB** of the 28.1 MB
int8 embedding table, or 9.4% of the 39.4 MB artifact. A riskier extension that also prunes the
14,252 "weak" pieces fired 1–99 times would save another 5.5 MB. Training does use that band,
so pruning it has a cost.

## Verdict

The survey implied that the embedding was about 72.5% of params at no more than 24% utilization,
so a prune could roughly halve the model. **That saving does not exist.** The real saving is 3.7
MB, and it would add a permanent id-remap coupling between tokenizer.model and model.onnx. Every
future fine-tune, splice and the browser loader would have to respect that new invariant. The trade
is not worth it, so the change was not built.

The wrong number came from the 2026-07-30 synthesis line "(shipped-eval utilization ~6.7%,
ceiling 24%)". The research agent did not commit the raw measurement behind it, so it cannot be
audited. It likely came from a small sample, or from the 48k base vocab rather than the full
73,143-piece spliced vocab measured against the full feed. The shipped-eval 6.7% figure is
directionally consistent with our narrower fixture-only sweep, but the "ceiling" figure is not.
**Standing lesson: re-derive a survey number from primary data before a task that depends on it
spends real effort. This probe did that as its first step, so it cost about 1 hour instead of a
build.**

## What survives

- The instruments: `measure_vocab_utilization.py` (fired counts over any manifest), and
  `prune_vocab.py` with `verify_prune.py` (the surgery pair and the B1/B2 bars). They are correct
  and reusable if a future vocab decision needs them.
- The telemetry: `$MAILWOMAN_DATA_ROOT/scratch-vocab-prune/utilization-v0150-venue.npz` (with its
  sidecar, eval-fired.json and eval-texts.json). It feeds directly into the CJK Phase-3 full-vocab
  rebuild and any v9 tokenizer-sizing decision. Vocab size should be set when the tokenizer is
  trained, since the model learns whatever vocab exists, rather than by surgery afterwards.
- The 13.7% never-fired band is real but small. The 100–999 band (37.2%) is the largest band,
  which shows that the vocab's working pieces sit in the mid-frequency tail. That argues against
  aggressive vocab shrinkage in any future retrain. It does not bear on this prune.
