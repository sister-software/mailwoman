---
sidebar_position: 16
title: Training recipe levers
---

# Training recipe levers

Every training run is defined by a YAML config with ~30 knobs. Most interact. This document catalogues each lever, what it does, how we arrived at the current value, what happens when you move it, and where we've found ceilings. The goal is to make the reasoning behind the recipe reproducible — not just the recipe itself.

Written after v0.5.0 (CE-only, h256, 50K steps) and v0.5.1 ("unchained," h384, 100K steps). Both trained on corpus-v0.4.0 with the A1 tokenizer.

## Architecture levers

### `hidden_size`

**What it does.** The width of every hidden representation in the transformer encoder. Every token is a vector of this many numbers. Wider = more capacity to represent distinctions between address components.

| Value | Where we used it                 | What happened                                               |
| ----- | -------------------------------- | ----------------------------------------------------------- |
| 256   | v0.3.0, v0.4.0, v0.5.0           | Stable. val_macro_f1=0.605 at 50K. The baseline.            |
| 384   | v0.5.0 bisect (h384 + dual-loss) | Diverged at step 700-1050 in all attempts.                  |
| 384   | v0.5.1 (h384 + CE-only)          | Stable. val_macro_f1=0.633 at 55K. Peak before overfitting. |

**How we got to 384.** The operator chose it as the v0.5.0 target. The plan doc described 256→384 as "paid for by rented GPU." The h384 bisect during the divergence campaign appeared to show h384 was a destabilizer — but it was actually the dual-loss interaction that was unstable at every size. Once CE-only fixed the training, h384 worked on the first try.

**Ceiling.** Not found. 512 is the next natural step (doubles the FFN intermediate from 1536 to 2048). Expected cost: ~2× wall time per step, ~4× parameter count (~68M vs 29M at h384). Whether the additional capacity helps depends on whether the model is capacity-limited or data-limited. The v0.5.1 overfitting past step 65K suggests data-limited at h384 — going larger without more data would overfit faster.

**What 256 buys you.** ~17M params, trains at 6.9 sps on A100 (h256 batch=16 ga=8) or ~120 sps (h256 batch=128 direct — untested but estimated). Fits on any GPU including consumer iGPUs.

### `num_attention_heads`

**What it does.** How many independent "perspectives" each transformer layer uses when deciding which tokens attend to which. Convention: head_dim = hidden_size / num_heads = 64.

| hidden_size | num_heads | head_dim |
| ----------- | --------- | -------- |
| 256         | 4         | 64       |
| 384         | 6         | 64       |

**How we got here.** Following the standard 64-dim-per-head convention from BERT. No experimentation on head count — it's always derived from hidden_size.

### `num_hidden_layers`

**What it does.** How many transformer blocks the input passes through. More layers = more sequential processing but slower.

**Current value: 6.** Unchanged since v0.1.0. The model is intentionally shallow — address parsing doesn't require the deep reasoning chains that language generation does. Most of the useful signal is local (neighboring tokens in a comma-separated address).

**Ceiling.** Not explored. 6 layers at h384 is ~29M params. 12 layers would be ~50M. The overfitting at step 65K suggests the current depth is sufficient for the data; more layers without more data would overfit faster.

### `use_phrase_priors`

**What it does.** When enabled, the encoder concatenates a per-token feature vector from the phrase grouper (Stage 2.7) onto the token embeddings before the first transformer layer. The feature encodes "is this token at the start/middle/end of a proposed phrase?" and "what kind of phrase does the grouper think this is?" (numeric, street, locality, etc.).

| Value | Where                              | What happened                                  |
| ----- | ---------------------------------- | ---------------------------------------------- |
| false | v0.5.0, v0.5.0 bisect (phrase-off) | Diverged (dual-loss issue, not phrase-priors). |
| true  | v0.5.1 (h384 + CE-only)            | Stable. val_macro_f1=0.633 at 55K.             |

**How we got here.** Phrase priors were the headline architectural contribution of v0.5.0 Thread E (phrase grouper) + Thread C (classifier conditioning). They were turned off during the bisect campaign because we couldn't afford to test each variable on slow hardware. The v0.5.1 "unchained" run turned them back on. They're stable under CE-only.

**What they're supposed to do.** Give the classifier a head start on boundary discovery. Instead of the model having to learn "these tokens belong together" purely from BIO label statistics, the phrase grouper's structural cues (punctuation, capitalization, hyphenation) provide a prior. The model can then focus on "what type is this span?" rather than jointly discovering boundaries and types.

**Whether they helped.** Unclear from the current data — we haven't run h384 + CE-only WITHOUT phrase priors on A100 to isolate the contribution. The 0.633 vs 0.621 delta between v0.5.1 and v0.5.0 conflates h384 + phrase priors + class weights + direct batch + more steps. An ablation (h384 + CE-only + phrase priors OFF) would isolate it.

## Loss levers

### `crf_loss_weight`

**What it does.** Multiplier on the CRF NLL term in the dual-loss: `loss = CE + crf_loss_weight × CRF_NLL`. At 0.0, the CRF NLL is not computed during training (CE-only). The CRF at inference (structural BIO mask + Viterbi decode) is always active regardless.

| Value   | Where                                       | What happened                            |
| ------- | ------------------------------------------- | ---------------------------------------- |
| 1.0     | v0.5.0 threads v1-v2 (§1 ON)                | Diverged step 700-1000.                  |
| 0.05    | v0.3.0, v0.4.0, v0.5.0 threads v3 + bisects | v0.3.0/v0.4.0: stable. v0.5.0: diverged. |
| **0.0** | v0.5.0 CE-only, v0.5.1                      | Stable. Best results.                    |

**How we got to 0.0.** The gradient-norm ratio probe (2026-05-24) revealed CRF gradient dominates CE by 8-20× at the divergence inflection point. Even at weight=0.05, the effective optimization mix was ~1:0.8 CE:CRF. Below loss 0.41, CE and CRF develop opposing curvature — the CRF pulls the model off its CE-preferred basin. See [dual-loss curvature conflict](../../concepts/dual-loss-curvature-conflict.md).

**What 0.05 did.** Shipped v0.3.0 and v0.4.0 successfully at h256 with those corpora. Failed at h384 and with the v0.4.0 corpus. The destabilization is recipe-dependent, not a universal property of 0.05 — it interacted with the larger model and/or the new corpus.

**Ceiling.** 0.0 is the floor. There is no known ceiling because any value > 0 reintroduces the curvature conflict on this data. The structural CRF benefits (no orphan I-tags) are preserved at inference via the frozen mask. The training-side CRF NLL is unnecessary.

### `class_weights`

**What it does.** Per-tag multiplier on the cross-entropy loss. Tags with weight > 1.0 cost more when mislabeled; tags with weight < 1.0 cost less. Used to steer the model's attention toward underperforming or hallucination-prone tags.

| Tag                    | v0.5.0 weight | v0.5.1 weight | Rationale                                                                                                              |
| ---------------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| O                      | 1.0           | 0.5           | O is the majority class (~60% of tokens). Downweight to give real tags more gradient signal.                           |
| B/I-street             | 0.5           | 2.0           | v0.5.0 had street F1=0.1% on golden. Upweight to force the model to learn streets.                                     |
| B/I-locality           | 1.5           | 2.0           | Coarse label regression from v0.3.0. Upweight.                                                                         |
| B/I-country            | 2.0           | 2.0           | Carried from v0.4.0.                                                                                                   |
| B/I-dependent_locality | 1.5           | **0.3**       | 956 FPs in v0.5.0 eval. Model hallucinates this tag. Downweight to make hallucination cheap → model stops emitting it. |
| B/I-subregion          | 1.5           | **0.3**       | 272 FPs with 0 TPs. Same hallucination pattern.                                                                        |
| B/I-venue              | 0.5           | 1.5           | Underperforming. Upweight.                                                                                             |
| B/I-house_number       | 0.5           | 1.5           | Underperforming on golden. Upweight.                                                                                   |

**How we got here.** The v0.5.0 eval matrix showed the 956 dependent_locality FPs and 272 subregion FPs as the most concrete failure. Setting their weight to 0.3 makes mislabeling a token as dependent_locality cheap — the model has no incentive to emit it. Meanwhile upweighting street, locality, venue, and house_number pulls the model's attention toward the tags that matter for exact-match accuracy.

**Whether it worked.** Pending — v0.5.1 training is still running. The eval at step 55K showed val_macro_f1=0.633 but we need the per-component breakdown to know if the hallucination was suppressed.

**Risks.** Setting dependent_locality too low (e.g. 0.1) could make the model unable to learn it at all — if the data ever includes legitimate dependent_locality examples, the model would ignore them. 0.3 is a compromise: low enough to suppress hallucination, high enough that a clear signal still trains.

### `label_smoothing`

**What it does.** Instead of training toward a hard 0/1 target per token, smooths the target to (1 - ε) for the correct class and ε/(K-1) for the others. Prevents overconfident predictions.

**Current value: 0.0.** Disabled in all v0.5.x runs. The 54.5% overconfident-wrong rate suggests we should turn it on — label smoothing directly addresses confidence calibration. However, the reconciler already addresses the overconfidence problem at the pipeline level (0.1% overconfident-wrong in hybrid-joint mode), so per-model calibration is lower priority.

**Next experiment.** label_smoothing=0.1 is the standard starting point. Expected effect: slightly lower peak macro_f1 (the model hedges its predictions) but more honest confidence scores.

## Optimizer levers

### `learning_rate`

**What it does.** How large a step the optimizer takes per gradient update. Too high = overshoots optima (divergence). Too low = converges too slowly or gets stuck.

| Value  | Where                              | What happened                    |
| ------ | ---------------------------------- | -------------------------------- |
| 5e-4   | v0.4.0 runs 1-2                    | Diverged step 750-1000.          |
| 3e-4   | v0.4.0 run 3                       | Diverged step 1000.              |
| 1.5e-4 | v0.3.0, v0.4.0 §4-only, all v0.5.x | Stable everywhere under CE-only. |
| 1e-4   | v0.5.0 LR-drop attempt             | Diverged (dual-loss, not LR).    |

**How we got to 1.5e-4.** v0.3.0 empirically found it as the stable LR for this architecture + corpus. v0.4.0 tried higher (5e-4, 3e-4) but the bisect showed divergence was recipe-driven, not LR-driven. 1.5e-4 has been the constant since.

**Ceiling.** Unknown under CE-only. The dual-loss divergence at higher LRs was caused by the CRF curvature conflict, which is gone. Higher LR might now be stable. But 1.5e-4 is working well enough that there's no pressure to explore.

### `batch_size` × `grad_accum_steps` (effective batch)

**What it does.** How many examples the optimizer sees before updating weights. Larger = smoother gradients (less noise), but each step covers more wall-clock time.

| Effective batch | How                  | Where                             | What happened                                                  |
| --------------- | -------------------- | --------------------------------- | -------------------------------------------------------------- |
| 128             | batch=32 × ga=4      | v0.3.0, v0.4.0 (local iGPU, h256) | Stable.                                                        |
| 128             | batch=16 × ga=8      | v0.5.0 (local iGPU, h256)         | Stable.                                                        |
| 8               | batch=8 × ga=1       | v0.5.0 smoke tests                | **Falsely passed** — eff_batch=8 hides the curvature conflict. |
| **128**         | **batch=128 × ga=1** | **v0.5.1 (A100, h384)**           | **Stable. 15-30× faster per step.**                            |

**How we got to batch=128 direct.** The A100 has 40 GB VRAM; the h384 model uses ~4 GB. No need for gradient accumulation. Direct batch=128 gives cleaner gradients (no micro-batch noise) and much higher throughput (120 sps vs 6.9 sps).

**The smoke-batch lesson.** Smoke tests at eff_batch=8 passed cleanly while full runs at eff_batch=128 diverged. At smaller batch sizes, the higher per-step gradient noise paradoxically stabilizes training against curvature conflicts (the model can't settle deep enough into the basin where the conflict manifests). This is now documented in [VERDICT_SMOKES.md](./VERDICT_SMOKES.md).

### `warmup_steps`

**What it does.** Number of steps over which the learning rate ramps linearly from 0 to its target. Prevents large gradient updates on a randomly initialized model.

| Value | Where               | Notes                                 |
| ----- | ------------------- | ------------------------------------- |
| 500   | v0.5.0 (50K total)  | 1% of training.                       |
| 1000  | v0.5.1 (100K total) | 1% of training. Proportional scaling. |

**How we got here.** Convention: 1% of total steps. No experimentation. Shorter warmup risks early instability; longer warmup wastes steps at low LR that could be learning.

### `lr_schedule`

**What it does.** How the learning rate changes after warmup. Cosine decays to near-zero; constant stays at peak.

| Value        | Where          | What happened                                                 |
| ------------ | -------------- | ------------------------------------------------------------- |
| cosine       | v0.3.0, v0.4.0 | Standard. But masked divergence in v0.4.0 smokes.             |
| **constant** | v0.5.0, v0.5.1 | Used per VERDICT_SMOKES.md mode A — new recipe = constant LR. |

**How we got to constant.** v0.4.0's cosine-LR smoke passed a recipe that diverged in the full run. Constant LR keeps the model at sustained peak LR for the entire training window — divergence surfaces immediately if the recipe is unstable. See [VERDICT_SMOKES.md](./VERDICT_SMOKES.md).

**Downside.** Constant LR can overfit faster (no LR decay to slow learning in late training). The v0.5.1 overfitting past step 65K may partly be caused by constant LR — cosine decay would reduce the learning rate by that point, slowing the overfitting. A future experiment: constant LR for the first 60K steps (validation), then cosine decay for the remaining 40K (refinement).

## Data levers

### `source_weights`

**What it does.** Per-source sampling weights in the training data loader. Higher weight = more rows from that source in each epoch.

Current values are carried from v0.4.0's §4 source rebalance (the only recipe lever that shipped clean in v0.4.0):

| Source         | Weight  | Why                                                                                                                                                      |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tiger          | 4.0     | TIGER carries structured US address patterns. Highest weight to compensate for its small raw shard count.                                                |
| ban            | 3.0     | French address patterns. Second-highest weight.                                                                                                          |
| wof-admin      | 2.0     | WOF admin names (locality, region, country).                                                                                                             |
| wof-postalcode | 2.0     | Postcode patterns.                                                                                                                                       |
| usgov-nad      | 1.0     | NAD was previously at 2.0 but dominated the sample (52% of shards). v0.4.0 dropped it to 1.0 to recover postcode positional exposure from other sources. |
| state-\*       | 1.5-2.0 | State-level government sources (Iowa contractors, Texas/NY notaries).                                                                                    |

**How we got here.** v0.4.0's postcode regression (F1 0.76 → 0.69) was traced to NAD's downweight removing "postcode comes first" positional patterns. The current weights are a compromise. Not re-validated since v0.4.0 — the corpus-v0.4.0 additions (kryptonite + transliteration) may shift the optimal mix.

### `country_weights`

**What it does.** Per-country acceptance probability in the data loader. Only US and FR are weighted (1.0 each) — these are the two locales with trained weights.

**Ceiling.** Adding more countries (RU, JP, AM, KR, CN) is the v0.6.0 roadmap. The A1 tokenizer already covers these scripts; the corpus has transliteration rows; only the classifier training is missing.

## Known ceilings and open questions

1. **Data ceiling at h384.** Overfitting past step 65K suggests the model has extracted what it can from corpus-v0.4.0 at this capacity. More data (v0.5.0 corpus expansion, v0.6.0 multi-locale) would raise this ceiling.

2. **Composition ceiling.** Per-token BIO accuracy (0.605-0.633 macro_f1) doesn't chain into per-component exact-match accuracy (0.1-6% on golden). This is a structural limitation of per-token training objectives. A future loss term that penalizes globally invalid parses (e.g. sequence-level negative log-likelihood over full addresses) would address this, but hasn't been explored.

3. **Reconciler ceiling.** Hybrid-joint improved exact-match from 0.1% to 6.0% with v0.5.0 weights. Whether this improves further with v0.5.1 weights depends on the classifier putting better alternatives in its top-K. The reconciler can only re-rank what exists.

4. **Calibration ceiling.** The 54.5% overconfident-wrong rate with v0.5.0 weights is a first-generation model problem. label_smoothing and temperature scaling are unexplored levers. The reconciler masks this at the pipeline level (0.1% overconfident-wrong) but per-model calibration would help all modes.

## See also

- [VERDICT_SMOKES.md](./VERDICT_SMOKES.md) — the smoke discipline that catches recipe failures
- [Dual-loss curvature conflict](../../concepts/dual-loss-curvature-conflict.md) — why crf_loss_weight=0 works
- [v0.5.0 — as shipped](../v0-5-0-shipped.md) — the thread table
- [What the eval numbers mean](../../understanding/our-approach/what-the-eval-numbers-mean.md) — plain-English interpretation
