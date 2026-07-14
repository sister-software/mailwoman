# Parity campaign — night-1 runbook (post-consult)

**Context:** the v7 excision is gated on `mailwoman eval parity` floors (house_number ≥ 0.97, postcode ≥ 0.97, street ≥ 0.90). Baseline after the $0 splice (v242-multisplice, staged on the data root): house_number 0.7273, postcode 0.9861 PASS, street 0.4033. Residual = label-pattern knowledge (fragments, trailing-number, AU units), proven not tokenizer-bound.
**Consult:** DeepSeek pro ×3 (session 019f590a, 2026-07-13). Structural advice adopted with corrections below; embedded numbers (ratios, step counts, thresholds) are STARTING HYPOTHESES to adjudicate, never gates — per the standing calibration policy.
**Papers (from `mailwoman-internal/community/research-bridges.md`):** Yin 2023 (BiLSTM-CRF beats transformers on messy real-user addresses — the fragment class); GLiNER + FSemi-CRF (the #727 span-head path); Kyutai Neutral Residues 2410.02744 (extension without forgetting); EuroBERT/Pleias (fertility→F1); mmBERT (low-resource pre-adaptation).

## The consult's structure (kept / corrected / rejected)

- **Kept:** fragment shard = confirmatory ASSAY, not the fix — the residual is span-head-shaped (converges with #727, independently). Anti-forgetting ranking: routed separate model (server tier) > Neutral-Residues adapters > plain shard + early-stop > freeze-encoder+head-only (insufficient capacity). Probe order by refutation cost. The read-out separator: token-F1 up while span-exact-match lags + trailing-number→postcode persists = span-head ceiling CONFIRMED.
- **Corrected (myopia):** a second encoder is server-tier only (pocket/WASM is size-gated); the kind-classifier router is UNMEASURED on fragments — measure before betting on routing; the decode-time street-morphology FST bias channel already exists (off by default).
- **Session's best find (blind-spot sweep + our own records):** the shipped bundle carries NO `crf-transitions.json` and CRF training diverged long ago (`crf_loss_weight=0.0` since v0.5.0) — decode runs on the structural BIO mask only. **Probe 0b: a transitions-only fine-tune (encoder frozen) is CPU-trainable and could suppress the trailing-number→postcode flip class as a pure decode-time sequence prior.** Nobody had this on the board.

## Night-1 punch list (one A100 budget, everything else CPU)

0. **Router measurement (CPU, first):** kind-classifier recall/precision on a synthetic fragment holdout (bare-street + street+number per locale, from the libpostal dictionaries/FST) + the parity corpus. Gates the routing path; nothing trains on it tonight regardless.
1. **Probe 0 — FST morphology bias ON (CPU):** wire `--fst`/`fstBiasScale` through `mailwoman eval parity` (the runner calls `classifier.parse` — ParseOpts already accepts `fst`), re-run parity. Watch: over-tagging on morphology hits inside non-street inputs; anchor-channel conflicts on number-adjacent tokens. Outcomes: sufficient / helpful-but-capped / harmful (expect capped: the bias can't fix numeric-neighbor label confusion — pre-registered prediction 1).
2. **Probe 0b — CRF transitions (CPU):** confirm decode ignores learned transitions today; fit a transition matrix on (base + fragment shard) labels with the encoder frozen; decode Viterbi-with-transitions; re-run parity. Cheapest possible sequence-prior lever.
3. **#511 base-consistency check (CPU):** for every street-labeled n-gram in the fragment shard, scan the BASE corpus label distribution (source-scoped, per the #511 memory). Contradiction pattern to expect: truncation-derived bare streets whose surface forms appear base-labeled as locality. Drop/re-label contradictions before weighting anything.
4. **Probe 1 — fragment-shard assay (GPU, the night's one training run):** shard = bare streets (dictionary/FST-synthesized, by-construction labels) + street+trailing-number (locale-aware number formats; NO postcodes in these rows) + truncations of existing gold. Small ratio (start ~5%, adjudicate); short decaying schedule (the v196 scar: constant-LR long runs overfit late); eval every 500 steps on fragment-dev AND full parity; early-stop on any parity floor regression. Read-out per the separator metric above.
5. **Write the dated eval report + grade the scoreboard.**

**Do-not-do (night-1):** no separate fragment encoder training; no adapter runs; no promotion of anything — even a clean-looking probe — without the full standard gate set (US-2k coord, per-locale F1, gauntlet, preset-compare); no grading candidates via `--model` explicit paths (use `--weights-cache`; the #718 zero-fill trap is documented in PR #1099).

## Pre-registered predictions (DeepSeek session 019f590a — grade after probes)

1. Probe 0: street recall on fragments improves; trailing-number→postcode confusion does NOT resolve (bias can't fix numeric-neighbor labels).
2. Probe 1: fragment-dev token-F1 rises materially; span-exact-match lags severely; trailing-number→postcode persists → #727 ceiling confirmed.
3. Router: fragment recall poor in ≥ a handful of locales; structured-address precision high (risk is recall, not precision).

Scoreboard (to fill): structural n/3 — quantitative: none registered (numbers were explicitly not solicited).

## After night-1

- Ceiling confirmed → the #727 arc (GLiNER-lite span loss as the intermediate step before a full FSemi-CRF head; fertility-aware vocab per EuroBERT as the deeper cut; mmBERT pre-adaptation for starved locales). Routing/adapters only if the span-head path stalls AND the router measurements came back clean.
- Floors clear on some future checkpoint → re-run the held plan-2 swap gates (`hold/v1-parse-neural-gate-blocked`) → plans 4–5 unblock → v7.
