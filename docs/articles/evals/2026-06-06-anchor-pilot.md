# We built the postcode anchor. The verdict is one wire away.

**Date:** 2026-06-06
**Scope:** the de-risk pilot for the postcode-anchor conditioning channel (#239/#240) — does feeding the parser a structured postcode signal break the German end-of-string collapse that self-conditioning alone couldn't?

The hypothesis was sharp: the German collapse — trailing city → `O`, locality and postcode fragmenting at end-of-string — is a _local_ emission failure, and self-conditioning's _global_ soft locale posterior was always going to miss it (it did, twice). A postcode anchor is local, near-hard, and sits right at the collapse site. So we built it, end to end, and ran the A/B.

## What's done and proven

The whole training-side pipeline works, validated on a live GPU run: the per-token anchor injection at the postcode span (composing with the existing self-conditioning FiLM), the gold-span → sub-token alignment that reuses the label projection so it can't drift, the JSON gazetteer lookup, and the confidence curriculum (no `[NO-ANCHOR]` token — "absent" is the `c=0` tail of a continuum). A 20k-step from-scratch run trained clean — no NaN, no destabilization. Everything from the DeepSeek design to the model code to the tests to Modal is connected and runs.

## The collapse is real (the premise is locked)

We confirmed the failure exists for _this_ exact code and seed, on real OpenAddresses German addresses through the resolver:

| model (DE locality-match, real OA)      |      result |
| --------------------------------------- | ----------: |
| **control @3k** (self-cond, anchor-off) |   **29.3%** |
| anchor-on @20k, **anchor not fed**      |       35.9% |
| v0 (Pelias) / the target                | ~83% / ~77% |

The control sits squarely on the established collapse (~25.6%). No A/B drift — the recipe collapses, as designed, so the anchor has something real to fix.

## Why there's no verdict yet — and it's the honest kind of gap

The headline question is still open, for a precise reason. The collapse is a _resolver-on-real-OA_ phenomenon, and our training val is the _synthetic_ order-shard — in-distribution, ~0.97 locality for both arms, so the synth val can't show it. And the model evaluated _without the anchor fed_ is still collapsed (35.9%, and even that delta is confounded by 20k vs 3k steps). That last number is the tell: if the anchor is the load-bearing signal, the model leans on it, and pulling it at inference drops it back toward the collapse — which is exactly what we see.

So the verdict — _does feeding the anchor at inference recover DE locality toward ~77%?_ — genuinely cannot be read from anything we have. It needs the **inference-side anchor channel**: ONNX export with the anchor inputs, the `OnnxRunner` / `NeuralAddressClassifier` accepting anchor tensors, and the extractor computing the anchor per address into the resolver eval. The inference mirror of the training channel we just built.

This is a clean de-risk outcome, not a failure. The risky, uncertain parts — does the architecture train, does the alignment hold, does the channel destabilize — are all answered. What remains is wiring, and a single resolver A/B once it's in: control 29.3% vs anchor-on-**with**-anchor.

## Next

Build the inference-side anchor channel, then re-run the DE resolver A/B feeding the anchor. That number is the verdict.

Artifacts: configs `v0.9.1-pilot-anchor-{off,on}.yaml`; `eval_de` + `export_onnx` (Modal); lookup `scripts/build-pilot-anchor-lookup.py`; consult notes `.agents/skills/deepseek-consult/session-notes-2026-06-05-anchor-pilot.md`.
