# 2026-07-15 — v264 country-softguard (#1104): softening the homograph guard is a clean win

v264 (`v2.6.4-country-softguard`) is a single-variable fine-tune off v263: `model.country_ambiguous_scale`
1.0 → 0.5. It **strictly dominates v263** on country with no offsetting trade — the first country
iteration in the #1104 arc that carries no documented exception.

## Why

The `eval gate --weights-cache` ledger backfill surfaced that v263's country channel cut both ways: its
`country_ambiguous` guard (a hard suppression of homograph country surfaces — Georgia/Jordan/Jamaica)
recovered WOF-admin country recall (84.8→89.3%) but dropped the country-homograph probe 89.8→82.6. The
guard was too strong. v264 softens it.

## The mechanism — `country_ambiguous_scale` (bakes into the ONNX, no lexicon/inference change)

A model-config scalar scales the `country_ambiguous` feature dim (index 1) of `country_features` BEFORE
`country_projection`, via a non-persistent registered buffer `[1.0, scale]`. Because the scale lives in the
forward pass, it **exports as a constant into the ONNX graph** — inference feeds the raw `[country_surface,
country_ambiguous]` clue and the graph does the scaling. No country-surface-lexicon change, no
`country-inference.ts`/`country_lexicon.py` change, no browser change. `1.0` = v263 (bit-identical);
v264 = `0.5`. (Serialize footgun fixed en route: the scale must be written into the checkpoint
`config.json`, else export silently rebuilds at 1.0 — the first v264 export was byte-identical to v263 on
the homograph probe until that was caught.)

## Grade (package-shaped throughout — `eval gate --weights-cache` / `loadFromWeights`, #718)

| Gate                                        | v263 (6.2.0)  | v264          | verdict                              |
| ------------------------------------------- | ------------- | ------------- | ------------------------------------ |
| **country-homograph F1** (real, n=54)       | 82.6          | **85.1**      | ✓ +2.5pp — recovers a homograph miss |
| **golden WOF-admin country recall**         | 200/224=89.3% | 204/224=91.1% | ✓ +1.8pp — the win holds AND grows   |
| **real-postal country recall** (falsifier)  | 3/4           | 3/4           | ✓ held                               |
| **hallucination** (300 real no-country)     | 1%            | 1%            | ✓ held                               |
| **held-out US coordinate** (300 FDIC, ≤5km) | 279           | 269 (z −0.14) | ✓ PASS                               |
| **held-out FR coordinate** (300 BAN, ≤5km)  | 281           | 264 (z +0.25) | ✓ PASS                               |
| **aggregate golden label-fails**            | 1101          | 1098          | ✓ −3 (net better)                    |

The finding beneath the numbers: softening the guard recovered country recall on **both** distributions at
once — the homograph test (its target) and the WOF-admin hierarchy (a bonus). The v263 hard guard was
over-suppressing country broadly, not only on true homographs; the `country_ambiguous` bit fires on any
flagged surface and v263 trusted it too little everywhere. At scale 0.5 the model trusts it more, recovers
recall, and precision holds (falsifier hallucination unchanged) because the softer bit is still an
informative false-positive signal, just not a near-veto.

## Headroom

0.5 recovers roughly half the homograph gap (82.6 → 85.1 of the 82.6 → 89.8 country-OFF range). A smaller
scale (0.25) would likely recover more homograph recall, but risks eroding the precision the guard buys
(hallucinations). 0.5 is the conservative clean win; 0.25 is a follow-up worth a probe if maximal homograph
recall is wanted.

## Reproduce

- Config: `corpus-python/src/mailwoman_train/configs/v2.6.4-country-softguard.yaml` (init_from v263,
  `country_ambiguous_scale: 0.5`).
- Mechanism: `model.py` `country_feature_scale` buffer + forward multiply; serialized in `config_dict`.
- Grade: `scratchpad/grade-v264.sh` (export → quantize → package-cache → homograph probe + falsifier +
  failure-report + gauntlet, all `--weights-cache`).
- int8 md5 `3e534072985d92bbbfa8b88d89ec53dc`.
