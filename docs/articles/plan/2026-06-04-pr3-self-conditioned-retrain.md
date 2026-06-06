# PR3 — the self-conditioned retrain (plan)

The third and largest step of the system-conditioning work. The consult and the risk-probe that motivate it are written up in the blog post "Does a postcode know what country it's in?" and the consult notes under `.agents/skills/deepseek-consult/session-notes-2026-06-03-system-conditioning.md`. PR1 (the codex inverse-mapping + the membership-gated anchor, #264) shipped. PR2 (an anchor-only locale prior replacing `--default-country`) was killed by the risk-probe before it was built. This is the piece the probe pointed at: teach the model to infer the country from the whole address and condition its own labeling on it.

This document is the plan, not a launch. It costs GPU time and changes the model, so the run waits on explicit sign-off. The decisions that need an operator call are collected at the end.

## Why now

The probe measured the assumption everything else rested on: a postcode pins its own country only 27.9% (US) / 44.1% (DE) of the time, because a bare five-digit code is a valid US ZIP, German PLZ, and French code at once. The strongest single pre-parse signal settles the country less than half the time, so the rest has to come from the city, the street, and the order the pieces arrive in. That is a job for the model reading the full sequence, which is exactly what self-conditioning is.

It also lines up with the failure that started the anchor work. The v0.8.0 German order-shard taught us that order is learnable cheaply, but the continue-train re-triggered the Saint-Albans span fragmentation at end-of-string — an emission-level collapse where a city's lead token bled into the postcode span. The hypothesis behind self-conditioning is that a model which has already resolved "this is a German address" globally, before it commits per-token labels, stops making that cross-tag mistake. The pilot is built to confirm or kill that hypothesis on a budget.

## What changes in the model

The architecture is grounded in `corpus-python/src/mailwoman_train/model.py` (`MailwomanCoarseEncoder`): a 6-layer, 384-hidden, 6-head pre-norm transformer encoder feeding a single linear BIO head over 33 labels (`labels.py`, 16 component tags). No locale representation exists anywhere in it today. Self-conditioning adds three small pieces and reuses one that is already there.

**1. An auxiliary locale head (the model's own country posterior).** Mean-pool the encoder output over non-pad tokens into a single vector, run it through `Linear(384 → num_locales)`, and train it with cross-entropy against the row's `country` field. The corpus already carries `country` on every row (`corpus/src/types.ts` `CanonicalRow`, the `country` parquet column `data_loader.py` reads), so the target is free. This head is what forces the pooled representation to actually encode "which country", and it closes the loop with the consult: it **is the authoritative `LocalePosterior`** the resolver wanted. Export it alongside the BIO output, and the resolver's swappable `localePriorProvider` finally has a strong producer to point at.

**2. Feedback from that posterior into the per-token labeling (the "self" in self-conditioning).** The design rule is that locale gets resolved globally, before per-token labels. So project the pooled locale representation into a FiLM modulation (a learned scale and shift) and apply it to the token representations feeding the BIO head: `h' = γ(p) ⊙ h + β(p)`. The model infers the country once from the whole string, then lets that inference reshape how it labels each token. If head-level FiLM proves too weak to move the cross-pollution metric, the escalation is to split the encoder and FiLM the back half (infer locale after layer 3, condition layers 4–6). That is more faithful to "before per-token labels" and more code, so it is the fallback, not the opening move.

**3. The cheap-prior / anchor input channel, via the seam that already exists.** The model has a `phrase_priors` path (`use_phrase_priors`, `model.py` ~159–223): an optional `(batch, seq, phrase_feature_dim)` feature tensor concatenated to the token+position embedding and projected back to hidden, defaulting to **zeros** when absent. That zero-default is the anchor-dropout mechanism the design asked for, already built. The postcode anchor's per-token signal (country posterior + confidence) rides in as additional feature dims on this channel, and dropping it to zeros ~20% of the time during training keeps the model from depending on it. The catch the grounding surfaced: there is **no path today from the TS anchor into the Python trainer** — the anchor is runtime-only, post-hoc repair (`neural/classifier.ts repairPostcodeLabels`). Feeding it to training means a precompute pass that writes the anchor signal into the corpus shards. That is real pipeline work, and it is why the pilot splits.

## The staging — prove the free thing first

The design doc bundled self-conditioning and the anchor channel into one pilot. The grounding argues for separating them, because they have very different costs and the probe already told us which one is load-bearing.

**Pilot A — self-conditioning only. No corpus rebuild.** Pieces 1 and 2 above. The locale target is the existing `country` column; nothing in the data pipeline changes. From scratch on US + FR + DE, balanced, against the v0.7.2 recipe with exactly one variable added (self-conditioning). Stop at the 20k-step gate. This is the cheapest possible test of the core hypothesis — does a model that infers locale globally and conditions on it parse better and stop the German cross-tag collapse — and it needs no new data engineering. If self-conditioning alone does nothing, the anchor channel is unlikely to rescue it, and we have spent a few dollars to learn that.

**Pilot B — add the anchor input channel.** Only if A clears its gate. Build the precompute pass (run the TS anchor over the corpus, emit per-token `anchor_posterior` + `anchor_confidence` columns into the shards), widen `phrase_feature_dim`, and retrain with anchor-dropout. This tests whether the anchor is a useful booster on top of self-conditioning, which is the one thing the probe could not measure (a wide `{DE, US}` prior plus city tokens may still let the model commit correctly).

**The real run.** Only after a pilot passes and 4–5 locales are staged. One from-scratch, balanced, self-conditioned run, judged by the resolver, promoted only if it clears the pre-registered bars below.

## Data and recipe

US and FR are already in the corpus (`country_weights {US: 1.0, FR: 1.0}` in the v0.8.1 config); the German OA adapter exists from the DE-1 work. Pilot A balances the three. Everything else holds at the v0.7.2 settings so self-conditioning is the only moving part: label smoothing 0.1, CRF **off** (`crf_loss_weight: 0.0`, because it NaN'd under bf16 twice and stays disabled until the core change is stable), the same tokenizer (v0.6.0-a0, so F1 stays comparable across the change), constant LR with a 1000-step warmup. New knobs land on the existing config dataclasses (`config.py`): `use_locale_conditioning`, `locale_loss_weight`, `num_locales`, `anchor_dropout_rate`. Any new reduction-heavy op (the pooling, the FiLM) runs in fp32 — the CRF NaN was a bf16-reduction failure, and we do not repeat that lesson.

## The new metric we have to build

The pre-registered tripwire is "per-locale, the rate of city-start tokens mis-tagged as `postcode` falls below 1% by 20k steps." That cross-pollution metric does not exist yet: the current evals (`scripts/eval/per-locale-f1.ts`, `corpus-python` `eval.py`) measure component F1 and calibration, not this specific confusion. It needs writing: over a held-out per-locale set, count how often a token whose gold label starts a `locality`/`region` span gets predicted `postcode`. This is the direct readout of the Saint-Albans collapse, and it is the gate that tells us self-conditioning is doing its job before we spend a full run.

## The gates (pre-registered, resolver is the judge)

No promotion on parser-F1 alone. These come straight from the anchor-based-parsing decision rules and this session's consult.

- **20k cross-pollution gate:** city-start-as-postcode under 1% per locale by 20k steps. If it will not clear, that recipe has hit its interference ceiling; stop the run.
- **No regression on the incumbents:** US and FR resolver utility within 1pp of v0.7.2. Adding DE must not drop an existing locale's resolver city-match by more than 2pp (the 77→43 German collapse is the thing we are guarding against).
- **DE has to actually move:** German locality F1 ≥ 70% and rising at the gate, or the run is not earning the German data.
- **Dropout robustness:** with the anchor channel zeroed and the locale signal dropped, degradation ≤ 5pp — proof the model learned to parse, not to lean on a crutch.
- **Promotion is the resolver's call.** Run the full `oa-resolver-eval` (US + DE, real OA points) and the per-tag error analysis; promote to default only if the resolver improves and no tag regresses more than 2pp. Otherwise the artifact ships labelled experimental in `releases.json`, not promoted, the same discipline as every prior cycle.

## Export and the resolver loop

The ONNX export (`export_onnx.py`) grows a second output: the BIO logits as today, plus the locale posterior from the aux head. At inference the locale head is cheap and useful — it is the `LocalePosterior` the consult specified, the strong producer the resolver's `localePriorProvider` was designed to swap in. When this lands, `--default-country` can finally retire, not because the postcode got smarter, but because the model now reads the whole address the way the probe said it had to. That is the payoff that PR2 reached for too early.

## Budget and protocol

The pilot is an A100 hour, roughly $3–8, inside the ~$30 already approved for the v0.7 line. The launcher is unchanged: `modal run -d scripts/modal/train_remote.py --config <new-config> --resume auto`, with `--trackio` for the live curves. The NaN protocol stands: one knob at a time (self-conditioning is the only change in A), fp32 for new reductions, stop on divergence and diagnose a single variable before the next attempt, document the hypothesis in the config YAML as a comment. Stop at 20k on a gate failure rather than burning the full run.

## File-level work list (Pilot A)

1. `corpus-python/src/mailwoman_train/config.py` — add `use_locale_conditioning`, `locale_loss_weight`, `num_locales` to `ModelConfig`.
2. `corpus-python/src/mailwoman_train/labels.py` — a stable locale-index map (country → id) for the aux head's target.
3. `corpus-python/src/mailwoman_train/data_loader.py` — surface `country` as a per-row locale-id target tensor (the column is already read).
4. `corpus-python/src/mailwoman_train/model.py` — the pooled locale head, the FiLM feedback, the aux output; all new reductions in fp32.
5. `corpus-python/src/mailwoman_train/train.py` — add the aux CE loss term, weighted by `locale_loss_weight`.
6. `corpus-python/src/mailwoman_train/eval.py` (and/or a new `scripts/eval/cross-pollution.ts`) — the city-start-as-postcode metric, per locale.
7. `corpus-python/src/mailwoman_train/configs/v0.9.0-pilot-selfcond.yaml` — the pilot config: US/FR/DE balanced, self-conditioning on, CRF off, v0.7.2 recipe otherwise.
8. `corpus-python/src/mailwoman_train/export_onnx.py` — export the locale-posterior output (wire into the resolver later, not in the pilot).

## Open decisions for the operator

1. **Approve the split** (Pilot A self-conditioning first, then B adds the anchor channel) over the design doc's bundled single pilot, or run them bundled.
2. **Locale granularity for the aux head:** country (US/FR/DE, matching the corpus `country` column) or BCP-47 locale (`en-US`/`fr-FR`, the optional `locale` column). Country is simpler and sufficient for the resolver; locale is finer but sparser. Recommendation: country for the pilot.
3. **Budget ceiling for the pilot** — confirm the $3–8 / one-A100-hour stop-at-20k envelope.
4. **Conditioning mechanism:** start with head-level FiLM (cheapest) and escalate to back-half FiLM only if the cross-pollution gate does not move, or go straight to back-half. Recommendation: start cheap, escalate on evidence.
