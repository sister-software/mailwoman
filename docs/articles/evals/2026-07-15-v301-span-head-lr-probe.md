---
title: v3.0.1 span-head re-probe — GATE PASS, the arc's premise holds
---

# v3.0.1-span-head-lr — the trained span scorer beats the token decode

**Gate (config-canonical, quoted verbatim from `v3.0.1-span-head-lr.yaml`):**

> `seg@1 > token@1` on the parity corpus, via `scripts/eval_seg_at_1.py`.
> v3.0.0 read seg@1 0.004 vs token@1 0.348 (CHANNEL-STARVED numbers).
> Secondary read: the span NLL must actually converge. If loss again ends ~17 and still falling, the
> LR is not the binding constraint and the fork reopens.
> If seg@1 STILL loses with a converged span loss: that IS the falsification.

## Verdict: **PASS**

|                           | token@1          | seg@1                |
| ------------------------- | ---------------- | -------------------- |
| **v3.0.1** (head LR 1e-3) | 131/267 = 0.4906 | **152/267 = 0.5693** |
| v3.0.0 (head LR 1e-5)     | 93/267 = 0.348   | 1/267 = 0.004        |

**seg@1 beats token@1 by +7.9pp under identical conditions.** Phase 1's question — _does a segment
decode over LEARNED span scores beat the token decode?_ — is answered **yes**.

## The secondary read confirms the diagnosis, not just the outcome

The v3.0.0 write-up called the failure _under-training, not falsification_, on the strength of a loss
that was still falling at 2k with raw span NLL ~35. One variable (the head's LR) tested that claim:

|               | step 400 | step 2000 | shape                           |
| ------------- | -------- | --------- | ------------------------------- |
| v3.0.0 (1e-5) | ~24      | **17.77** | still falling — never converged |
| v3.0.1 (1e-3) | **1.69** | **1.37**  | flat from ~1800 — converged     |

Raw span NLL ~2.7 (1.37 ÷ the 0.5 weight) against v3.0.0's ~35. The LR **was** the binding
constraint. A fresh head cannot train at a pretrained encoder's fine-tuning LR — the probe was
mis-specified, exactly as diagnosed, and repairing it changed the answer completely.

## Functional evidence (the aggregate is not the verdict)

```
'Korunni 810, Praha'  → Korunni:street  810:house_number  Praha:locality
'350 5th Ave, NY…'    → 350:house_number  5th:street  Ave:street_suffix  New York:locality  NY:region  10118:postcode
'Rue Montmartre'      → Rue Montmartre:locality        ← still wrong
```

- **`Korunní 810` is the #727 archetype** — the case v264 mangles into `street="Korunní 8"` +
  `house_number="10"`, the boundary-inside-a-number failure that motivated this whole arc. The span
  decode gets it right. Compare v3.0.0's random-per-token output
  (`▁Kor:street un:region ni:subregion`).
- **`Rue Montmartre` → locality is still wrong**, and that is _expected_: it is the bare-fragment
  recall class (66% of street failures, night-3 partition), which the span head was never going to
  fix. It is option C's target (kind-posterior soft channel + recall-weighted loss) and is
  deliberately out of Phase 1's scope. Its survival here is the plan's prediction holding, not a
  surprise.

## Bonus finding: the span loss improved the BIO head

token@1 went **0.348 → 0.4906** on the same channel-starved harness between v3.0.0 and v3.0.1, and
val macro F1 went 0.7405 → **0.7479**. The two runs differ only in the head's LR, so the co-trained
span objective is shaping the shared encoder to the BIO head's benefit — the same "span-consistency
pressure helps" effect stage-1's aux head showed, but larger. Worth confirming on production config
in Phase 2; not claimed as a shipped win here.

## What this does NOT establish

- **These absolutes are channel-starved.** `eval_seg_at_1.py` feeds no anchor/gazetteer/country
  channels, no postcodeRepair, no word-consistency heal (the #718 trap). Its token@1 reads 0.4906
  where the JS harness reads **0.573 on v264**. Do not compare across harnesses. The gate is valid
  because it is a _relative_ comparison — both heads read the same starved encoder state.
- **The 0.90 parity floor is untouched by this.** Phase 1 was never a promote gate; this checkpoint
  ships nowhere. Whether seg@1 clears 0.90 under production config is a Phase-2 question, and the
  night-3 oracle@10 ceiling (0.749 over v264's emissions) says the floor needs the recall class too,
  not just the boundary class.
- **2k steps, one seed.** No claim about the 8k shape.

## Run facts

|              |                                                                       |
| ------------ | --------------------------------------------------------------------- |
| Run          | `ap-XoqeNxSPUsObFIpsM7nXZL`, A100, 2000/2000, ~23 min                 |
| Variable     | `train.span_head_learning_rate: 1e-3` — the ONE change vs v3.0.0      |
| Param groups | head 101,076 @ 1e-3 \| encoder 39,259,055 @ 1e-5 (printed by the run) |
| Init         | `init_from` v264 step-008000, `missing=9 unexpected=0`                |
| NaN          | none — fp32 partition math held again                                 |
| Checkpoint   | `output-v301-span-head-lr-s42/checkpoints/step-002000`                |

## Next

Phase 2 (ONNX export of the span scores + the #378 SLO check) is now justified — it was gated on
exactly this crossing. Then Phase 3 (JS k-best) and Phase 4 (resolver rerank + option C).

The one thing worth deciding first: an **8k run at this LR** would tell us whether seg@1 keeps
climbing before Phase 2's export work commits to a checkpoint — cheap (~1.5h A100) and it is the
same one-variable step the campaign already knows how to grade.
