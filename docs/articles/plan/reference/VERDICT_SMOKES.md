# Verdict-smoke framework

A **verdict smoke** is a short (few-hundred-to-few-thousand-step) training run whose only job is to decide whether a full-length training run is worth launching. The full run is expensive (rented GPU, ~6–10h); the smoke runs in minutes and is supposed to surface divergence, NaN, sampler starvation, and other recipe-level bugs before they cost a full-run.

This document captures the v0.4.0 meta-bug that made the framework unreliable, and the redesigned framework v0.5.0 (and onward) uses.

## The cosine-LR meta-bug

The v0.4.0 ablation campaign (issue [#116](https://github.com/sister-software/mailwoman/issues/116), retrospective [v0-4-0-ablation-campaign](../../retrospectives/v0-4-0-ablation-campaign.md)) ran a verdict-smoke matrix at `max_steps=3000` over the §1/§3/§4 single-knob ablations. The `cw-only` smoke (§3 class-weighted CE + §4 source rebalance) passed with peak `macro_f1=0.4279` at step 2250 — clean curve, no warning signs.

Promoted to the full 50K run, **`cw-only` diverged at step 2250** — `macro_f1` collapsed 0.41 → 0.29.

Why the smoke missed it: the smoke ran cosine LR decay over `warmup_steps=1000` → `max_steps=3000`. By step 2250 the cosine schedule had decayed the learning rate to roughly `0.5 * (1 + cos(π * 0.625))` ≈ **30% of peak**, and by step 2750 to ~6%. The destabilizing dynamics needed sustained peak LR to manifest, and the cosine tail collapsed the LR before the loss curve made the divergence visible.

The smoke was reporting "this recipe is stable at this hparam slice" when what it had actually demonstrated was "this recipe is stable when LR is decaying off". Two different statements; the smoke conflated them.

This cost a 6h rented-GPU full-train cycle.

## The redesigned framework

Pick one of two modes for every smoke. Default is **constant-LR** for any new or unstable recipe.

### Mode A — Constant-LR (default)

Linear warmup from 0 → `learning_rate` over `warmup_steps`, then **flat at `learning_rate` for the entire smoke window.** No decay.

- Divergence shows up immediately because nothing is masking it.
- The smoke window is a "would this recipe survive at sustained peak LR" probe — which is exactly the question that matters for "will the full run blow up."
- Use this for any recipe that introduces a new loss term, a new normalization scheme, new class weights, a tokenizer change, or any other lever that hasn't been validated at full LR before.

### Mode B — Long-tail cosine

Cosine schedule, but `max_steps >= 10000` so the cosine tail does not dominate the visible portion of the smoke window. By step 3000, with `max_steps=10000`, LR is still at ~84% of peak — close enough to peak that destabilization can still surface.

- Use this when the recipe is a tweak on a known-stable baseline (a small source-weight nudge, a tiny class-weight adjustment within a previously-stable family) AND when the full-train cosine dynamics matter for the verdict you're trying to reach.
- Costs more wall-clock than constant-LR smokes (a 10K-step smoke is ~6× the wall-clock of a 1.5K-step constant-LR smoke).

### Which to pick

| Situation                                                                  | Mode                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| New recipe (new loss, new normalization, new tokenizer, new class weights) | **A — constant-LR**                                     |
| First time exercising a knob at a new LR                                   | **A — constant-LR**                                     |
| Tweak on a known-stable baseline (`±20%` source weight, etc.)              | **B — long-tail** if cosine dynamics matter; else **A** |
| Pre-flight integration check (wiring, dtype, sampler) — not a verdict      | Either; constant-LR is faster                           |
| Reproducing a known divergence to characterize it                          | **A — constant-LR**                                     |

When in doubt: pick constant-LR. The false-positive cost (a stable recipe gets flagged at sustained peak LR when it would actually survive cosine decay) is small — you just promote it to the full run anyway. The false-negative cost (a divergent recipe passes the smoke and burns a full run) is what the v0.4.0 campaign paid.

## How to invoke

The CLI accepts `--smoke-mode {constant,long-tail}` on both `train` and `smoke` subcommands.

```bash
# New recipe — default constant-LR smoke (recommended)
python -m mailwoman_train train \
    --config corpus-python/src/mailwoman_train/configs/<recipe>-smoke.yaml \
    --smoke-mode constant

# Tweak on a known-stable baseline — long-tail cosine
python -m mailwoman_train train \
    --config corpus-python/src/mailwoman_train/configs/<recipe>-smoke.yaml \
    --smoke-mode long-tail   # requires max_steps >= 10000 in the config

# End-to-end pipeline smoke (train → eval → export → quantize → package)
# Defaults to --smoke-mode constant.
python -m mailwoman_train smoke --config <recipe>-smoke.yaml
```

The flag overrides `cfg.train.lr_schedule`. Non-smoke (full) runs continue to use whatever the config declares — by default cosine, unchanged from v0.4.0.

Long-tail mode does not change `max_steps`; it asserts the recipe already has it sized correctly and warns when `max_steps < 10000`.

## Reading a smoke result

A smoke is **only** answering "would this recipe survive sustained peak LR for the smoke window?" — it is not predicting full-run F1, full-run convergence step, or anything else.

- **Loss is finite and trending down / sideways across the full smoke window** → promote to full run.
- **Loss spikes, NaN, or trends up at any point in the smoke window** → recipe is unstable at this LR. Reduce LR or revisit the recipe.
- **Loss looks fine until the cosine tail (constant-LR mode disabled)** → you've reproduced the v0.4.0 meta-bug. Re-run in constant-LR mode.
- **Val F1 peaks early and decays** in a constant-LR smoke → may still be fine in the full run (early-stopping or full-cosine recovers it), but the smoke is not the layer that decides this. Promote and let the full run be the verdict.

## Sidecars that ride alongside

Three v0.4.0 diagnostic tools that should run against every v0.5.0 smoke / full-run pair. Each is in the tree as of 2026-05-23.

- **`corpus-audit`** ([`corpus/scripts/audit.ts`](https://github.com/sister-software/mailwoman/blob/main/corpus/scripts/audit.ts)) — per-source shard-count × source-weight diagnostic. Run before training to verify the sampled mix matches intent. Catches the v0.3.0 "NAD = 35% effective sample" class of footgun before it costs a training cycle.

  ```bash
  npx tsx corpus/scripts/audit.ts /data/corpus/versioned/<rev>/corpus-<rev> \
      --config corpus-python/src/mailwoman_train/configs/<recipe>.yaml
  ```

- **`diagnose_regression.py`** ([`corpus-python/scripts/diagnose_regression.py`](https://github.com/sister-software/mailwoman/blob/main/corpus-python/scripts/diagnose_regression.py)) — post-eval FP/FN bucketing (`non_latin` / `case_only` / `bio_slip` / `empty_pred` / `num_confused` / `other`). Use it on every eval pass, not just post-hoc — bucket distributions are how recipe choices get debugged. The v0.4.0 retrospective entry documents reference distributions for calibration.

- **Decoder span-trim** (commit [`c72ab4c`](https://github.com/sister-software/mailwoman/commit/c72ab4c), `core/decoder/build-tree.ts:58`) — `trimBoundary(raw, start, end)` shrinks BIO span bounds past leading / trailing non-`/[\p{L}\p{N}]/u` characters. No retrain required; covers the `bio_slip` long tail the phrase grouper (Thread E) hasn't been designed to catch yet.

## See also

- [The knowledge ladder](../../concepts/the-knowledge-ladder.md) — why v0.4.0's failure modes mapped to missing pipeline rungs (the smoke meta-bug is the process-side companion).
- [Phase 8 — v0.5.0 fresh-slate](../phases/PHASE_8_v0_5_0_fresh_slate.md) — Thread F lands this framework before B/C/E start training.
- [Phase 2 — training](../phases/PHASE_2_training.md) iteration log — v0.4.0 entry has the original false-positive case.
- [v0.4.0 ablation campaign retrospective](../../retrospectives/v0-4-0-ablation-campaign.md) — full incident write-up.
- [Operations](./OPERATIONS.md) — working norms; smokes commit at the unit boundary like any other change.
