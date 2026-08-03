---
title: v3.0.0 span-head probe — INCONCLUSIVE (under-trained), not falsified
---

# v3.0.0-span-head 2k probe — the head never trained; the gate does not adjudicate

**Gate (config-canonical, quoted verbatim from `v3.0.0-span-head.yaml`):**

> `seg@1 > token@1` on the parity corpus. Baselines (v264, ship config): street token@1 0.573; a
> segment decode over the SUMMED-BIO stand-in scored 0.453.
> Secondary read: oracle@10 must RISE from 0.749.
> If seg@1 < token@1: do NOT tune span_loss_weight and re-run — that is the treadmill. One
> diagnostic (is the loss decreasing?), then fork to the operator.

**Result: the gate reads FAIL, but it does not adjudicate the arc.** Per the pre-registered
diagnostic, this is **under-trained, not falsified** — and the honest call is the fork, which is why
this doc exists rather than a relaunch.

## What ran

|            |                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Run        | `ap-2xQYXyXtcLhyIsdoSpTp0v`, A100, 2000/2000 steps, ~31 min                                      |
| Config     | `v3.0.0-span-head.yaml` — ONE variable vs v264: `use_span_scorer: true`, `span_loss_weight: 0.5` |
| Init       | `init_from` v264 step-008000 — `missing=9 unexpected=0` (exactly the 9 new span tensors)         |
| NaN        | none. fp32 partition math held where the v0.5.0 bf16 CRF NaN'd twice                             |
| New params | 101,076 of 39,360,131 (0.26%)                                                                    |

## The numbers

Channel-starved (see the caveat below) — **relative comparison only**:

|                            |                    |
| -------------------------- | ------------------ |
| token@1 (BIO argmax)       | 93/267 = **0.348** |
| seg@1 (semi-Markov argmax) | 1/267 = **0.004**  |

## Why this is under-training, not falsification

The pre-registered diagnostic is "is the loss even decreasing?". It is, and it is nowhere near
converged:

| step       | 50    | 450   | 850   | 1200  | 1600  | 2000      |
| ---------- | ----- | ----- | ----- | ----- | ----- | --------- |
| train_loss | 26.41 | 25.33 | 21.22 | 18.84 | 18.12 | **17.77** |

- **Still falling at 2000** (18.12 → 17.77 over the last 400 steps). Not a plateau.
- **The raw span NLL is ~35** (17.77 ÷ the 0.5 weight, less the ~1 CE). A converged semi-CRF sits at
  O(1). The head is a small fraction of the way in.
- **The decode looks random**, exactly as a near-random head should:
  `Korunni 810, Praha` → `▁Kor:street un:region ni:subregion ▁8|1|0:postcode` — a type per token with
  no structure. Compare the BIO head on the same input: `▁Kor|un|ni:street ▁8|1|0:house_number
▁Pra|ha:locality` — correct.

**The probe was mis-specified, and that is my error.** `lr: 1e-5` was inherited verbatim from
v2.6.4 — a recipe that _fine-tunes existing weights_. The span head is **randomly initialized**. A
fresh head at a fine-tuning LR for 2k steps cannot train, and the one-variable discipline (correctly)
stopped me from also changing the LR, so the probe tested "does a barely-initialized head beat a
fully-trained one" — a question with a known answer.

## The BIO head is untouched — the byte-identity property held in a real run

The step-2000 eval, which is the useful result here:

|           | street | house_number | postcode | locality | region | macro  |
| --------- | ------ | ------------ | -------- | -------- | ------ | ------ |
| v300 @ 2k | 0.869  | 0.995        | 0.999    | 0.765    | 0.754  | 0.7405 |

The span head trained alongside without perturbing the BIO path — the unit test's invariant, now
confirmed under real gradient. That much of Phase 1 is proven.

## Caveat that limits this harness (a second design error, also mine)

`eval_seg_at_1.py` runs Python-side against the torch checkpoint, deliberately, to avoid depending on
the Phase-2 ONNX export. But the Python side **feeds no anchor/gazetteer/country channels, no
postcodeRepair, no word-consistency heal** — the #718 channel-starvation trap. So its token@1 reads
0.348 where the JS harness reads **0.573 on the same model**. The absolute numbers here are NOT
comparable to `mailwoman eval parity --weights-cache`, and the script now prints that in its output.

The _relative_ gate survives (both heads read the same starved encoder state), but any future
Phase-1 re-run should either feed the channels or accept that only the comparison is meaningful.

Two harness bugs were found and fixed getting here, both by refusing to accept a token@1 that
couldn't reproduce a known baseline:

1. `from_pretrained()` never passed `map_location`, so a GPU-trained checkpoint **could not load on a
   CPU-only box at all**. This affects every local grading run, not just this one.
2. The gate concatenated street-family _pieces_, dropping the `O`-labelled bare `▁` separator and
   welding words (`▁5|th|▁|Ave` → `"5thAve"`). Now slices by char offsets. token@1 0.285 → 0.348.

## The fork (operator's call — the pre-registration says so)

The arc is **not** falsified. The question the probe was meant to answer is still open. Options:

1. **Re-probe with a head-appropriate LR** — e.g. a param-group LR for `span_scorer`/`semi_crf` at
   1e-3 while the encoder stays at 1e-5. This is standard for a fresh head on a pretrained encoder,
   and it is _not_ the treadmill (the treadmill is opposite-direction knob oscillation; this is
   fixing a mis-specified probe). Cheapest real test of the hypothesis.
2. **8k at the current LR** — tests whether duration alone gets there. Slower, and the trajectory
   suggests it would still be far from converged.
3. **Park Phase 1** and revisit with the option-C recall channel bundled (violates one-variable, but
   the 66% bare-fragment class is the bigger prize anyway).

My recommendation is (1): it is one variable (the head's LR), it costs ~30 min of A100, and it is the
only option that actually tests the architecture rather than re-testing a random head.

## Artifacts

- Branch `feat/727-span-head` — 8 commits, 21 unit tests (both DP routines brute-force verified).
- Checkpoint: `output-v300-span-head-s42/checkpoints/step-002000` on the Modal volume.
- `train_log.csv` pulled to `/tmp/v300-log.csv`.
