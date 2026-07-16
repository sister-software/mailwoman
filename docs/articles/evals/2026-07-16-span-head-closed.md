# The span head is done — the deciding run says −3.2pp against a plain decode

**Pre-registered kill shot** (`v3.2.0-fragment-span.yaml`, written before any number existed):
`seg@1` must beat v310's `token@1` = **56/63 (0.889)** — the bar the flag failed. _"If a shard-trained
span head cannot beat a shard-trained plain decode on the target class, the span head has no case at
any weight and the arc closes."_

**Result: 54/63 = 0.857. −3.2pp. The arc closes.**

## The measurement

Paris target class, n=63, production config, int8 vs int8, one variable off v310 (the head):

|                                          | Paris             | 95% Wilson     |
| ---------------------------------------- | ----------------- | -------------- |
| v264 `token@1` (shipped)                 | 33/63 = 0.524     | [0.403, 0.642] |
| v301 `seg@1` (OLD corpus + span)         | 48/63 = 0.762     | [0.644, 0.850] |
| **v310 `token@1` (shard, NO span head)** | **56/63 = 0.889** | [0.788, 0.945] |
| v320 `seg@1` (shard + span head)         | 54/63 = 0.857     | [0.750, 0.923] |
| v320 `token@1` (the SAME model)          | 56/63 = 0.889     | [0.788, 0.945] |

**Within-model, same weights, same channels, same fixtures: `token@1` 56/63 → `seg@1` 54/63.** The
span decode loses to the BIO argmax of the model it is attached to. v301's within-model margin
was +0.38pp; on a corpus that teaches bare streets it is **−3.2pp**.

## Why this is the end, not a tuning problem

The head trained correctly and we verified it before reading anything:

- `[span_head_lr] head=101,076 @ 1e-3 | encoder=39,259,055 @ 1e-5` — the param-group split is real.
  A fresh head cannot train at a pretrained encoder's fine-tuning LR; #727 Phase 1 spent a whole run
  learning that.
- `init_from v310/step-008000 missing=9 unexpected=0` — the 9 missing tensors ARE the span head.
  `missing=0` would have meant a silently inherited head.
- loss 24.71 (random init) → 1.5328 → 1.2981 → **1.2500**, past v3.0.0's converged ~1.37.

**It learned. What it learned is worse than not having it.** And it learned on the corpus T1c named
as the missing condition, so "it wasn't trained on the right data" is spent.

The config's own instruction applies: **do not tune `span_loss_weight` and re-run.** That is the
treadmill the arc's guard forbids.

## The shape of the whole arc, in one table

|                                 | Paris target class | what it means                     |
| ------------------------------- | ------------------ | --------------------------------- |
| v301 seg, OLD corpus            | **+23.8pp**        | the span head looked like the fix |
| v310 token, shard, NO span head | **+36.5pp**        | the data was the fix              |
| v320 seg, shard + span head     | **−3.2pp**         | the span head is now a liability  |

**The span head was worth +23.8pp when the data was wrong, and −3.2pp once the data was right.** It
was compensating for a training-distribution defect. A compensator for a defect you have fixed is not
a feature; it is drag.

## What the arc bought

Four phases, and no shippable artifact. Worth saying plainly rather than dressing up.

What it produced instead is the reason the fix exists. `oracle@k` and the k-best decode made the
headroom **visible** — oracle@10 0.775 against a 0.577 rank-1, a gap invisible to every gate that
scored top-1. That gap motivated T1a's cross-tab, which found the digit-eating and forced the
hallucination check, which motivated T1c's board, which found the house-number licence, which built
T2's shard, which fixed the class the span head was built to rescue.

The arc asked whether a better decode could find the right answer. The answer was never in the list
to be found — it was not in the training data. **The instrument that proved the answer was not there
is what led us to put it there.** That is what four phases bought, and it is not nothing.

## What survives, and what does not

**Does not survive:** the span head, the k-best decode as a product surface, the flag (§6 of the
review follow-up), option C, and — by premise-collapse — the name-index rerank.

**Survives, and is now the standing instrumentation:** `oracle-k` (the headroom tracker), the
fragment board with its negative class, the parity precision half, `baselines.json` and its refusal,
and the v6 gate cut from the shipped model.

**Survives as the open work:** Track B — digit ownership. Untouched by any of this.

---

**Reproduce:** `node scratchpad/paris-4way.mjs`
