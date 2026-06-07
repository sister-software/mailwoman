# Leakage-split F1 — openaddresses-us-sample.jsonl

Per-tag F1 split by corpus-held-out geography (VT/WY/ND) vs in-training geography. A large in-training − held-out gap = the headline F1 is partly memorization (#371).

- held-out rows: 1428 · in-training rows: 8572 · model: `neural-weights-en-us/model.onnx` (v4.0.0)

| tag       | held-out F1 | in-training F1 | gap (in − held) |
| --------- | ----------: | -------------: | --------------: |
| locality  |       1.000 |          0.987 |          -0.012 |
| region    |       1.000 |          0.999 |          -0.001 |
| postcode  |       1.000 |          0.996 |          -0.004 |
| **macro** |   **1.000** |      **0.994** |      **-0.006** |

## Per-state macro-F1 (difficulty confound check)

| state |    n | macro-F1 | held-out?   |
| ----- | ---: | -------: | ----------- |
| MT    | 4284 |    0.979 |             |
| DC    | 4287 |    0.992 |             |
| IA    | 4287 |    0.996 |             |
| SD    | 4284 |    0.998 |             |
| CA    | 4287 |    1.000 |             |
| VT    | 4284 |    1.000 | ✅ held-out |
| IL    | 4287 |    1.000 |             |

## Read

DeepSeek (2026-06-07) flagged geographic train/test leakage as the top risk to our headline F1: the model trains on the corpus (tiger/BAN/WOF), which covers the same streets and localities OA tests, so component recall could be partly memorization. The corpus holds out specific US geography (VT/WY/ND) from training, so OA rows there test places the model never saw.

The result refutes that hypothesis on the tags OA can grade. Held-out Vermont scores 1.000 macro-F1 against 0.994 in-training, so held-out is if anything marginally easier. The per-state spread tells the same story from another angle: Montana (in-training) is the worst at 0.979 while Vermont (held-out) ties California and Illinois at the top. The ordering tracks intrinsic state difficulty, not training exposure. The shipped en-US model's locality/region/postcode recognition generalizes to unseen geography, and the near-perfect numbers also confirm that these three tags on clean, canonical US addresses are essentially a solved problem.

One caveat carries the whole result, so it's worth stating plainly. This only tests `locality`, `region`, and `postcode`, because that's all OpenAddresses gold carries. Leakage would bite hardest on STREET recognition, where memorizing a street name is the obvious shortcut, and OA can't grade street at all. A complete leakage check needs full-BIO corpus gold restricted to held-out geography, which is tracked as a follow-up on #371. And only Vermont survives in this US sample (Wyoming and North Dakota contribute zero rows), so the held-out signal is one state wide.

Reproduce: `node --experimental-strip-types scripts/eval/leakage-split-f1.ts --eval data/eval/external/openaddresses-us-sample.jsonl --held VT,WY,ND --out-md <path>`.
