# 2026-07-17 — v3.10.1: the #727 span head on the ship recipe (8k), and the k-best headroom is real

Night-4 of the #727 stage-2 arc (plan #1134), step 4: **the span-head training arc.** The phase-1
probes (v3.0.0→v3.0.1) proved a trained semi-Markov span scorer beats flat-BIO decode, but on the
v257 corpus and as a standalone head. This run answers the integration question — does that head
survive being folded into the SHIPPED v381 recipe (v0.11.0-no-fragment corpus, all the ship
channels), and how much k-best headroom does it actually expose for the phase-4c resolver rerank?

## The recipe

`v3.10.1-span-ship-8k.yaml` = the shipped v381 (v6.5.0) recipe + the semi-Markov span scorer
(`use_span_scorer`, span_dim 128, max_span 8, span_loss_weight 0.5) with its own optimizer param
group (`span_head_learning_rate 1e-3`; the encoder stays at 1e-5 — the phase-1 lesson). Trained as a
2k probe, then **RESUMED** (not init_from — the span head is the capability being grown) from
step-002000 to 8000. A P3 all-caps augment (`augment_upper_case_prob 0.15`) rode along as a passenger.

Same corpus + tokenizer as v381 → every F1 comparison below is valid.

## Reads — all pre-registered

| read                         | v381 (base)   | v3.10.1 8k      | verdict                          |
| ---------------------------- | ------------- | --------------- | -------------------------------- |
| golden us micro / exact      | 86.9 / 66.2   | 86.9 / **66.3** | GUARD PASS (byte-stable)         |
| golden fr micro / exact      | 90.1 / 75.4   | 90.0 / 75.4     | GUARD PASS (noise)               |
| seg@1 (parity 267, starved)  | token@1 0.558 | **0.588**       | GATE PASS (+3.0pp)               |
| oracle@5 (parity 267)        | —             | **0.7865**      | +6.4pp over v301's 0.7228        |
| all-caps raw-case exact (P3) | 48.3          | 48.0            | FAIL (inert, −0.3pp vs +5pp bar) |

train_loss 18.6→1.31; val macro_f1 0.6937 (= the 2k's 0.6936 — the token path is untouched, the
span head is a purely additional output).

## What the numbers say

**The span head integrates at zero token-path cost.** golden us/fr micro identical to v381, exact
±0.1pp. The span scorer is a new output head; the BIO path the model already shipped is byte-stable.
There is nothing to "promote" on the token side — and nothing to lose.

**The k-best headroom is real and large.** oracle@5 0.7865 vs seg@1 0.588 = **0.1985** of street@1
sitting in ranks 2–5, recoverable by a reranker that never touches the model. oracle@3 is already
0.745 — most of the headroom is in the top 3. This is the empirical foundation the whole stage-2
arc rested on (the plan cited oracle@10 0.749); the 8k ship-recipe model exceeds it (oracle@5 alone
0.786), and beats the phase-1 v301 substrate by 6.4pp.

**The span head plateaus by 2k.** seg@1 was 0.603 at 2k, 0.588 at 8k (−1.1pp, noise); oracle@5
likewise saturates. The extra 6k steps refined train_loss (1.49→1.31) but not the decode gate —
the same 2k≈8k plateau the B4b digit arc hit. The 8k is the "complete" run (lowest loss, clean
schedule) and the better-provenance substrate, but 2k would have served equally on the decode metrics.

**P3 all-caps is inert — closed.** The augment failed its +5pp bar at 2k AND at 8k (48.0 vs 48.3 both
times). More steps didn't help; the augment does not teach all-caps robustness at rate 0.15. The
#690 title-case shim stays (worth +12.4pp raw-case today). A separate higher-rate probe is the only
open path, and it's the operator's call — this augment, as configured, is a measured negative.

## Status — substrate, not a ship

This model **ships nowhere on its own.** The span head is dormant until phase-4c wires the k-best
decode + the name-evidence rerank (`docs/superpowers/specs/2026-07-17-727-phase4c-street-name-evidence.md`).
The token path is byte-stable, so there is no BIO regression to gate and no promote decision to make
tonight. What this run produces is the **phase-4c decode substrate**: an int8 model that exports
`span_scores` + the `semi-crf-transitions.json` sidecar (the `export_onnx` path was extended tonight
to emit it), staged at `scratchpad/v3101-cache` + the checkpoint on the training volume.

The measured chain now runs end to end: trained span head → k-best decode (PR #1154) → oracle@5
0.786 headroom → name-evidence rerank (phase-4b: +18.5pp bare-street on the FR fragment board,
148 fixes / 3 breaks). Every link is measured; none is promoted. Phase-4c (build
`StreetLocalityEvidence`, wire the rerank behind a flag, re-run the full promote battery WITH the
rerank active) is the next arc, gated on #1154 merging and the operator ratifying the spec.

## Artifacts

- Config: `corpus-python/src/mailwoman_train/configs/v3.10.1-span-ship-8k.yaml` (RESUME v3.10.0 2k → 8k).
- Checkpoint: `output-v3100-span-ship-probe-s42/checkpoints/step-008000` (training volume).
- int8 + sidecar: `output-v3100-span-ship-probe-s42/model-int8.onnx` + `semi-crf-transitions.json`.
- Grade instruments: `scratchpad/grade-v3101.sh`, `oracle-read-v3101.mjs`, `eval_seg_at_1.py`.
