---
sidebar_position: 18
title: Dual-loss curvature conflict — when CRF is the aggressor
---

# Dual-loss curvature conflict — when CRF is the aggressor

:::tip[No ML background needed]

If you're a software engineer curious about what went wrong but you don't have machine learning experience, start with the **[Beginner's companion](#beginners-companion--the-cooperative-vs-conflict-model)** below — it explains the problem using a two-GPSes-on-a-foggy-hill metaphor, no math required.

:::

A specific failure mode of CE + CRF dual-loss training that surfaced across nine of mailwoman's v0.5.0 attempts. Documented here because the diagnostic technique generalises and the fix is simple once you know what's happening.

If you haven't read [the v0.4.0 ablation retrospective](../retrospectives/v0-4-0-ablation-campaign.md) and the [bisect-by-elimination blog post](pathname:///blog/2026-05-24-bisect-by-elimination), do those first — they set up the failure pattern this article diagnoses.

## The failure fingerprint

Across every recipe variant tried — different learning rates, hidden sizes, with and without class weights, with and without per-token CRF normalisation, with and without phrase-prior input features — training showed the same shape:

1. **Clean descent through warmup.** Loss drops monotonically as expected.
2. **Brief plateau near loss 0.41** (the deepest point any run reached).
3. **Sharp climb back to the starting magnitude** over the next 100-300 steps.

Validation macro-F1 mirrored the train loss curve — peaked when loss bottomed, collapsed to roughly random-baseline as loss climbed. The collapse step shifted with learning rate (lower LR → later collapse), but a factor-2 LR drop only delayed the collapse by ~1.3× — too sub-linear for "we just picked too high an LR" to explain.

The bisect ruled out: learning rate, per-token CRF normalisation (§1), class-weighted cross-entropy (§3), hidden size (h384 vs h256), phrase-prior input features. That left two suspects — the tokenizer / corpus pair — and one we hadn't named: the dual loss itself.

## The diagnostic technique

For any model trained with a sum of two loss terms (here CE + `λ`×CRF NLL), the question "which loss is dominating the optimisation right before divergence?" has a cheap answer. Take a checkpoint from the just-before-climb step. Run one forward, then two backwards — once with CE only, once with CRF only — and compare gradient norms.

```python
# CE-only backward
ce_loss = F.cross_entropy(logits.view(-1, num_labels), labels.view(-1), ...)
ce_loss.backward(retain_graph=True)
ce_norm = sum(p.grad.detach().pow(2).sum() for p in model.parameters() if p.grad is not None) ** 0.5

# CRF-only backward
model.zero_grad()
crf_loss = model.crf(emissions=logits, tags=labels.clamp(min=0), mask=crf_mask, reduction=crf_reduction)
crf_loss.backward()
crf_norm = sum(p.grad.detach().pow(2).sum() for p in model.parameters() if p.grad is not None) ** 0.5

ratio = crf_norm / max(ce_norm, 1e-12)
```

The whole probe runs in a few minutes against an existing checkpoint. No retraining, no instrumentation in the train loop, no special-mode flag — just two backwards on a stored set of weights.

## What the probe revealed

Two checkpoints sampled — one at the inflection point (loss settled at 0.63, about to climb) and one deep in the climb (loss 1.92):

| Checkpoint           | Phase                   | `‖∇_CE‖` | `‖∇_CRF‖` | **ratio**       |
| -------------------- | ----------------------- | -------- | --------- | --------------- |
| v3-ablation step-500 | settled, about to climb | 7-17     | 149-275   | **median 16.2** |
| phrase-off step-1500 | deep in climb           | 4-5      | 30-46     | **median 8.0**  |

Two conclusions, both unexpected before the probe:

1. **The CRF gradient is 8-20× larger than the CE gradient.** With `crf_loss_weight=0.05`, that means the effective contribution to backward is roughly 1:0.8 CE:CRF — close to 1:1 weighted, dominated by CRF. The hand-tuned `crf_loss_weight` knob did not produce the gentle CRF regularisation it was supposed to.
2. **The ratio shrinks during divergence (16 → 8).** Not because CRF is collapsing — CRF gradient is still 30-45 in magnitude — but because CE is growing relative to CRF as the model gets dragged off its basin. CE is fighting back and losing.

## The cooperative vs conflict regime model

The probe results are consistent with a specific story about why dual-loss training survives early and breaks late:

**Above loss ~0.41 (cooperative regime).** The model starts at high entropy — random predictions, no structural understanding. Both loss surfaces slope downhill toward the same broad basin: "become less random." CE wants to refine per-token accuracy from random. CRF wants to maximise transition-probability coherence from random. Both objectives direct the optimiser the same way. Training descends cleanly.

**Below loss ~0.41 (conflict regime).** The model exits the high-entropy basin and starts making fine-grained decisions — specific per-token trade-offs between similar tags, structural patterns the CRF can score. CE and CRF stop agreeing. CE wants to refine per-token accuracy. CRF wants transition-probability shapes that may push individual tokens toward technically-coherent but locally-wrong tags. The two objectives now point in opposing directions on this data.

The optimiser follows whichever loss has the larger gradient. With CRF at 16× CE magnitude, the CRF wins. The model gets dragged off its CE-preferred basin toward a CRF-preferred attractor that CE actively disagrees with. CE loss climbs as collateral damage.

The "below 0.41" boundary isn't a magic constant — it's the level at which the cooperative-vs-conflict transition happens on this specific data and architecture. Different corpora, different label spaces, different model sizes would shift it. The structure of the failure is the load-bearing observation.

## Why the standard repairs don't help

Several recipe knobs that ought to address this all failed in mailwoman's v0.5.0 attempts:

- **Lowering `crf_loss_weight`** from 0.1 to 0.05 produced the v0.4.0-shipped weights, which still showed early signs of the same fingerprint (postcode regressed, full-parse exact match fell). The gradient-norm asymmetry is large enough that lowering the weight knob doesn't keep up — at `crf_loss_weight=0.05`, CRF still contributes 0.05 × 16 = 0.8× CE in optimization.
- **Per-token CRF normalisation** (§1) — was meant to make CRF NLL magnitude comparable to per-token CE. The probe shows the _gradient_ magnitudes are still wildly different even when _loss_ magnitudes were normalised. Loss-magnitude balance does not imply gradient-magnitude balance.
- **Global gradient clipping** to norm 1.0 — applied to the combined gradient after the dual-loss sum. Doesn't address the _relative_ dominance; CRF's 16× share of the budget is preserved through clipping.

The pattern: knobs that _scale_ loss values don't fix asymmetric _curvature_. Below the cooperative-regime boundary, CRF NLL has a loss surface where small parameter changes produce large gradients on this data — and no amount of multiplicative weighting will rebalance that against CE's gentler surface.

## The repair

Drop the CRF NLL loss term entirely during training. Keep the CRF as an inference-time structural decoder, with its frozen transition mask + Viterbi.

The structural benefits the CRF was supposed to provide — no orphan I-tags, no `Saint → Petersburg` clipping bugs from BIO-invalid spans — come from the **transition mask**, not from training the transition matrix via NLL. The mask is hand-encoded in `crf.py`: it forbids `O → I-locality` and every other BIO-invalid transition by setting those entries to `-inf` at initialisation. The training-side NLL was layered on top as a learned refinement; it's that learned refinement that fights with CE.

```python
# Before — the v0.4.0 train loop
loss = ce_loss + self.crf_loss_weight * crf_loss

# After — CE-only training, CRF stays at inference via frozen mask + Viterbi
if self.crf is not None and attention_mask is not None and self.crf_loss_weight > 0:
    crf_loss = self.crf(emissions=logits, tags=labels.clamp(min=0), mask=crf_mask, reduction=crf_reduction)
    loss = ce_loss + self.crf_loss_weight * crf_loss
else:
    loss = ce_loss
```

Gated on `self.crf_loss_weight > 0` so the change is backward-compatible: existing recipes that ship with `crf_loss_weight: 0.05` still compute CRF; the new behaviour activates only when a recipe explicitly sets `crf_loss_weight: 0.0`. No new config field, no coordination bugs between flags.

Inference unchanged. The runtime still calls `model.crf.decode(emissions, mask)` for Viterbi over the frozen mask. Structural validity preserved; opposing-curvature problem gone.

## What to measure when validating the repair

A CE-only smoke run that has to convince you the repair works:

- **Loss stable past step 2000.** Every prior dual-loss run diverged by step 2000. If CE-only stays at or below its basin minimum past that point, the repair holds.
- **val_macro_F1 ≥ 0.35 at step 2000.** v0.4.0-shipped is 0.36; h256-bisect peaked at 0.40 before diverging. 0.35 says "stable AND nearly as good as the best dual-loss checkpoint ever reached" — and the stability is the win that matters.
- **Per-tag F1 trajectory.** Total macro_F1 hides tag-level collapse. If `venue` F1 drops from 0.39 to 0.05 while `house_number` climbs, you have a quality redistribution problem CE-only hasn't fixed. Cost: zero — confusion matrices for per-tag F1 are already computed during eval.

If the smoke passes those gates, promote to a full 50K-step CE-only training run. Quality refinements (class weights, source weights, longer schedules) become safe to layer on top — they were unsafe under dual-loss because they amplified whichever loss was already aggressive.

## What this technique generalises to

Any training setup where you sum two loss terms with a hand-tuned weight, and observe a "trains fine then catastrophically diverges" pattern, has the same diagnostic available:

1. Take a checkpoint from the just-before-divergence step.
2. Compute per-loss gradient norms via separate backwards.
3. Read the ratio. Far-from-one means one loss is dominating; the loss-value-weighted multiplier you set may not produce the gradient-magnitude balance you assumed.

The bug shape is symmetric — it could be the auxiliary loss dominating (mailwoman's case) or the primary loss dominating (rarer; would look like the auxiliary loss being ignored). Either way the diagnostic is the same and so is the repair frame: if a loss term is destabilising training, drop it from training and reintroduce it at inference if its structural contribution justifies the integration cost.

## Beginner's companion — the cooperative-vs-conflict model

This section explains the same phenomenon without math or ML jargon. If you're a software engineer who found this page and want to understand the debugging story before reading the technical details, start here.

### The two voices

When Mailwoman trains its model, it uses two different scoring systems — call them **Voice A** and **Voice B**:

- **Voice A** (cross-entropy loss) asks: "How good are your guesses for each individual word? Did you tag '350' correctly as a house number? Did you tag 'NY' correctly as a region?"
- **Voice B** (CRF loss) asks: "How sensible is your overall pattern? Is your sequence of tags structurally valid? Does it look like a real address?"

Both voices are useful. A working address parser needs both per-word accuracy AND sensible patterns. The model's training combined both voices, with Voice B scaled down to 5% of Voice A's contribution — the assumption being that Voice B would contribute lightly as a structural nudge.

### The cooperative regime

Imagine two GPS devices on a foggy hill, both telling you which way is downhill.

At the top of the hill (high loss, model is still random), every direction is downhill. Both GPSes agree and point you roughly the same way. You make progress. The model's loss decreases steadily through the warmup phase.

### The conflict regime

As you descend into a specific valley (loss gets lower, model gets better), the landscape becomes more detailed. The two GPSes start disagreeing: Voice A says the valley floor is to the left; Voice B says it's to the right. They no longer see the same valley.

When that happens, your hiking direction is determined by **whichever GPS is shouting louder**. We measured this directly — took a snapshot of the model just before the climb started and measured each voice's contribution. Voice B's gradient was **16× larger** than Voice A's. Even scaled to 5%, Voice B was contributing roughly 80% as much as Voice A to the actual parameter updates.

Voice B pulled the model away from the basin Voice A was guiding it toward. Voice A's score (per-word accuracy) got worse — which we saw as the loss climbing back up.

### The fix

**Silence Voice B during training.** Keep it for inference (when the trained model actually parses addresses), where its structural rules — "no orphan tags, no invalid BIO sequences" — are enforced by the frozen CRF mask. But during training, let Voice A guide the model alone.

This is a one-line configuration change: `crf_loss_weight = 0.0`. The structural guarantees come from the hand-encoded mask, not from training the transition matrix. Training the transition matrix is what was fighting with Voice A.

### Why this matters beyond Mailwoman

Three lessons that generalise:

1. **"Add two losses together with weights" can be a disaster.** Two loss functions can have wildly different gradient magnitudes even when their loss _values_ look comparable. Multiplicative scaling on the loss value does not produce balanced contributions to the optimizer.
2. **Cheap diagnostics first.** The gradient-norm probe took 5 minutes and answered more than a month of retraining experiments. Always exhaust the zero-GPU diagnostic ladder before a retrain.
3. **ML debugging is more like programming debugging than the field admits.** Bisect, isolate, instrument, hypothesise, test. The hard part is finding the right vocabulary for what's happening inside the model. Once you have it, the bug is usually findable.

## See also

- [v0.4.0 ablation campaign retrospective](../retrospectives/v0-4-0-ablation-campaign.md) — first appearance of the divergence fingerprint, before the diagnostic was named
- [Bisect-by-elimination blog post](pathname:///blog/2026-05-24-bisect-by-elimination) — the bisect ladder that narrowed the suspects before the probe ran
- [Synthesis review](../reviews/2026-05-24-claude-deepseek-followup-synthesis.md) — the multi-agent conversation that produced both the dual-loss hypothesis and its falsification
- [`VERDICT_SMOKES.md`](../plan/reference/VERDICT_SMOKES.md) — the smoke discipline that catches this class of divergence (constant-LR, full-eff-batch)
- [CRF decoder](./crf-decoder.md) — the frozen-mask Viterbi the runtime keeps using even when training drops the NLL
