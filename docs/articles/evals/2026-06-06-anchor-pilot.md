# We fed the parser its postcode. German came halfway back.

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

## The verdict: the anchor is real, and partial

We then built the inference-side channel — ONNX export with the anchor inputs, `OnnxRunner` + `NeuralAddressClassifier` feeding them, and a TS feature builder whose layout is pinned to the Python training function by a cross-language test — and ran the DE resolver A/B with the anchor fed:

| DE locality-match (real OA)        |       result |
| ---------------------------------- | -----------: |
| control @3k (anchor-off)           |        29.3% |
| anchor-on @20k, anchor **not fed** |        35.9% |
| **anchor-on @20k, anchor fed**     |    **45.8%** |
| v0 (Pelias) / target               | 83.4% / ~77% |

The clean, unconfounded number is the **same checkpoint with the anchor off vs on**: `35.9% → 45.8%`, **+9.9pp purely from feeding the anchor**, nothing else changed. The model genuinely leans on the signal — the architecture's premise holds, end to end.

It is a **partial** fix. 45.8% is well short of ~77%, so the anchor helps real and measurably but doesn't fully reverse the collapse at this pilot scale.

**The per-state split is the mechanism — and points at the next lever.** Sachsen (postcodes `01xxx–09xxx`, little US collision) jumps `37.1% → 54.9%` (+17.8pp); Berlin (`10xxx`, colliding hard with US ZIPs) barely moves, `34.7% → 36.7%` (+2pp). The anchor's recovery is **gated by postcode ambiguity**: where the code pins the country it works strongly; where the posterior is a DE/US collision the uniform distribution can't decide and the model stays collapsed. Disambiguating the colliding ranges is where a full fix lives.

## Next levers

- **Extend to a 100k run** — the 20k gate passed (the anchor helps); does the effect grow with training?
- **Disambiguate the colliding ranges** — fuse the anchor into the self-conditioning posterior so an ambiguous code (`10115`) and a decisive city token (`Berlin`) sharpen each other.
- **Strategic check** — the resolver already does German at 83% (v0 parse → resolver), so weigh the parser-anchor (the multi-locale universal-parser bet) against resolver-side gains (the anchor centroid alone already cut coord p99 330 → 46 km).

Artifacts: configs `v0.9.1-pilot-anchor-{off,on}.yaml`; `eval_de` + `export_onnx` (Modal); lookup `scripts/build-pilot-anchor-lookup.py`; consult notes `.agents/skills/deepseek-consult/session-notes-2026-06-05-anchor-pilot.md`.
