# Mailwoman validation sprint synthesis — 2026-05-24 (Claude × DeepSeek follow-up)

A follow-up to the [Codex review](./2026-05-24-codex-project-direction-review.md) and the [DeepSeek synthesis review](./2026-05-24-deepseek-project-direction-review.md). Captures a six-turn technical back-and-forth between Claude (host-claude / operator's Jarvis) and DeepSeek-v4-pro, conducted via `pi --continue` on the same session that produced the DeepSeek review.

The conversation refined four parts of the original reviews and named three blind spots both reviewers missed. This document is the operational synthesis used to drive the next validation sprint.

## What changed vs the original reviews

| Area                                       | Original review position                                                                                   | After conversation                                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capacity-wall hypothesis                   | DeepSeek listed as one of two unexamined hypotheses                                                        | Falsifiable in 5 minutes via gradient-norm ratio probe; demoted to "rule out, don't pursue" until probe results land                                                                                                                             |
| Ordering of joint-reconcile vs bisect      | Both reviews put joint-reconcile after training experiments (Codex Step 3, DeepSeek Step 2 after Step 0.5) | Joint-reconcile **first** — zero GPU, can run against v0.4.0 weights today, measures the architectural thesis independent of training stability. DeepSeek conceded the reordering.                                                               |
| Top-k integration for v0.4.0 weights       | Implicit assumption: needs a TS beam decoder port or synthetic top-k                                       | **Option C**: expose per-token logits from ONNX (already emitted, currently discarded), aggregate softmax across phrase-grouper spans for per-span top-k. ~100 lines, real model confidences, code path matches the eventual production runtime. |
| Fine-tuning DistilBERT control             | DeepSeek Step 0.5 — high priority, ahead of bisect                                                         | Demoted to "nuclear option" — only run if CE-only training also diverges. The dual-loss decoupling probe + CE-only repair is cheaper and more diagnostic.                                                                                        |
| Go/no-go decision rule for joint-reconcile | Both reviews listed 10+ metrics but no decision rule                                                       | Two-axis matrix: **+15pp kryptonite exact-match** AND **≤1pt golden v0.1.2 macro_F1 regression** as the gating conditions. Combined exact-match on `kryptonite ∪ golden` as the single headline number.                                          |

## The dual-loss decoupling probe

The most important technical contribution from the conversation. Falsifiable in 5 minutes against an existing diverged checkpoint.

**Diagnostic:** during the climb phase of the loss curve (steps ~700-1000 across all five v0.5.0 diverged runs), log:

```
ratio = ‖∇_CRF‖ / ‖∇_CE‖
```

per training step. Single backward pass through CRF head vs CE head with `retain_graph=True` gives this in one forward-backward.

**Interpretation:**

| Ratio behaviour                                                                                                | Conclusion                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drops below ~0.01 at the inflection step (loss begins climbing, CRF gradient collapses while CE stays healthy) | Dual-loss instability. The model has decoupled the two objectives and is optimising only CE; CRF-NLL contributes dead gradient and exploding loss value. |
| Both gradient norms spike together, OR CE diverges while CRF stays flat                                        | Capacity wall. The model is in a pathological region where every parameter update makes everything worse.                                                |

**Repair if dual-loss confirmed:** drop the CRF-NLL loss term entirely. Keep the CRF as an inference-time structural decoder (frozen transition mask + Viterbi). The structural benefits (no orphan I-tags, no `Saint → Petersburg` clipping) come from the transition mask, not from training the transition matrix via NLL. Production NER systems do this routinely. One-line config change: `loss = ce_loss` instead of `loss = ce_loss + crf_loss_weight * crf_nll`. **`crf_loss_weight=0` has literally never been tested in this codebase** — v0.4.0-shipped runs at 0.05, all v0.5.0 attempts ran at 1.0 (§1 ON) or 0.05 (§1 OFF).

## The Option-C top-k integration

For wiring `reconcileSpans` against v0.4.0 weights without porting a new beam decoder to TypeScript:

- The ONNX model already emits per-token logits — the current runtime discards them after argmax. Keep them.
- For each span proposed by the phrase grouper, sum softmax probabilities across the span's tokens for each candidate tag.
- Take top-K tags per span.
- Feed `(span, tag, score)` triples into `reconcileSpans` as the classifier-top-k input.

Why this is better than the alternatives:

- **vs porting beam decoder to TS**: half the work (~100 lines vs 200-300), and sequence-level n-best decoding was the wrong abstraction for the reconciler anyway. The reconciler takes per-span confidence, not BIO-sequence-level confidence.
- **vs synthesised top-k**: real model confidences (no artificial perturbations of argmax), so the measurement reflects the actual classifier signal.
- **vs waiting for PR #128's top-k inference**: code path matches the eventual production runtime — when the top-k classifier eventually trains, the TS runtime just swaps "per-token softmax aggregation" for "classifier's top-k API," same downstream contract.

## Go/no-go decision matrix for joint-reconcile vs argmax

Two gates, applied after running joint-reconcile against the kryptonite catalogue (4,771 rows) and golden v0.1.2 (4,535 entries) using v0.4.0 weights + Option-C top-k:

| Kryptonite Δ exact-match | Golden Δ macro_F1 | Verdict                                                                                                                           |
| ------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ≥ +15pp                  | ≤ −1pt            | **Go**. Architecture validated. Train v0.5.0 weights to beat this.                                                                |
| ≥ +15pp                  | > −1pt            | Golden regression. Concordance scoring is hot or resolver gives wrong parent_id chains for normal addresses. Fix scoring, retest. |
| < +15pp                  | ≤ −1pt            | Architecture isn't earning its complexity. Revisit scoring/algorithm before any training experiments.                             |
| < +15pp                  | > −1pt            | Both broken. Step back and diagnose why before any further work.                                                                  |

**Why kryptonite exact-match is the primary signal:** the 4,771 rows were built for exactly the cases argmax gets wrong (`NY-NY Steakhouse, Houston, TX`, `Paris, Texas`, `Saint Petersburg, FL`). If joint decode doesn't lift exact-match by at least 15 absolute percentage points there, the architectural complexity isn't earning its keep.

**Why golden ≤1pt as a guard rail:** concordance scoring should be a no-op on already-correct parses. A >1pt regression on golden means the scoring function is making correct → wrong flips, which indicates a scoring bug, not an architectural failure.

**Explicitly not the top-line:** resolver top-1 accuracy. If the parse is wrong, the resolver will be wrong regardless. Exact-match measures what the reconciler actually changes; resolver accuracy gates a later "is our WOF data good?" question that joint decode can't answer.

## Three blind spots both reviews missed

Real risks that would have bitten the validation sprint if executed without mitigation:

### 1. WOF parent_id chain correctness

The concordance bonus in `reconcileSpans` scores parses against the gazetteer's parent-id chain. WOF SQLite is a copy of a copy of a copy. If `parent_id` chains are incorrect for even a small percentage of records, the concordance bonus will both punish correct parses AND reward wrong ones — and the failure mode is "<+15pp on kryptonite, you blame the algorithm, the real cause is bad data."

**Mitigation:** before evaluating reconciler output, spot-check 20 resolvable `(locality, region)` pairs against WOF's REST API as ground truth. If >1 mismatch, the concordance scoring is evaluating against bad data.

### 2. v0.4.0 weights may be too weak to surface the reconciler's value

The reconciler works by re-ranking — it takes the classifier's top-K, then concordance-scoring picks the coherent one. If the classifier's top-3 per-token are all wrong on kryptonite (e.g. `NY → region` ranked top-1, top-2, top-3), no amount of reconciler scoring fixes a broken input. The reconciler needs the **right answer to exist in the candidate set**.

**Mitigation:** if kryptonite Δ < +15pp, before concluding "reconciler broken," audit each failed example. Was the correct tag in the classifier's top-3? If no, the bottleneck is classifier quality (need new weights), not reconciler algorithm. That's a different conclusion entirely.

### 3. Golden v0.1.2 is too small to be a trustworthy regression guard

4,535 entries. A 1pt macro_F1 regression is ~45 entries flipping. At typical 1% annotator error rate in human-labeled NER data, that's another ~45 entries of noise. The "regression" signal has a ~10% false-positive rate from annotation noise alone — you could ship joint decode that's genuinely better and still "fail" the golden gate.

**Mitigation:** if golden regression lands in the 0.5–1.5pt band, manually inspect all disagreement entries before deciding. If >half are debatable or clearly wrong in golden, expand the gate tolerance. If they are genuine (concordance damage), the matrix stands.

## Updated validation sprint plan

Execution order — all but the final step run against v0.4.0 weights or existing checkpoints. Zero rented GPU before the validation matrix produces a "Go" verdict.

### Track A — zero-GPU diagnostics (parallel, today)

1. **Gradient-norm ratio probe** on a diverged v0.5.0 checkpoint. ~5 min.
2. **WOF parent_id spot-check** — 20 `(locality, region)` pairs vs WOF REST API. ~15 min. Mitigates blind spot #1.
3. **Status doc freeze** — reconcile `TODO.md`, `STAGES.md`, `ARCHITECTURE.md`, `runtime-pipeline.ts` comments, `tokenization.md` against `v0-5-0-shipped.md`. ~2 hours.

### Track B — TypeScript integration (parallel with Track A)

4. **Per-span logit aggregation** in the TS runtime — expose per-token logits from ONNX, aggregate over phrase-grouper spans, emit `(span, tag, score)` top-K triples. ~100 lines + tests.
5. **Wire `reconcileSpans` into `runPipeline` behind `forceJointReconcile` flag.** Uses Option-C top-k from step 4.
6. **Eval matrix script** — runs joint-reconcile vs argmax fallback against kryptonite + golden, emits the four numbers (kryptonite Δ exact-match, golden Δ macro_F1, combined exact-match, per-example failure audit) needed for the decision matrix.

### Track C — gated on Track A + B results

7. **Decision via the matrix** (see above).
8. **CE-only training run** if Track A step 1 confirms dual-loss decoupling. crf_loss_weight=0, otherwise v0.4.0-stable recipe. ~6h local GPU.
9. **Corpus/tokenizer bisect** only if Track A is clean AND joint-reconcile produces +15pp.
10. **Fine-tuning DistilBERT control** only if CE-only also diverges (nuclear option).
11. **Rented GPU C-train** only after the preflight checklist passes — the architecture has been measured end-to-end and the corpus/tokenizer destabiliser has been identified.

## Discipline notes from the conversation

A few principles worth carrying forward beyond this specific sprint:

- **A go/no-go decision rule must exist before the experiment runs.** A 10-metric report with no decision criterion is not an experiment; it's a data-collection exercise. The Codex review's eval-matrix list is correct but operationally incomplete without DeepSeek's threshold matrix.
- **Agreement across reviewers ≠ correctness.** Both Codex and DeepSeek converged on similar conclusions, but converging reviewers can share blind spots — the three named above are evidence that pushing past consensus is sometimes the only way to find what's actually missing.
- **Cheap diagnostics first.** A 5-minute gradient-norm probe answers more about the v0.5.0 divergence than a 25-hour retrain. Always exhaust the zero-GPU diagnostic ladder before any retrain.
- **The integration test is the architectural test.** v0.5.0's thesis is that joint decoding beats argmax on kryptonite. That thesis can be measured today, against v0.4.0 weights, with zero GPU time. There is no good reason to defer it behind any training experiment.

## See also

- [`./2026-05-24-codex-project-direction-review.md`](./2026-05-24-codex-project-direction-review.md) — the first independent review
- [`./2026-05-24-deepseek-project-direction-review.md`](./2026-05-24-deepseek-project-direction-review.md) — the synthesis review this conversation continues from
- [`docs/articles/plan/v0-5-0-shipped.md`](../articles/plan/v0-5-0-shipped.md) — as-shipped state of v0.5.0
- [`docs/articles/plan/reference/VERDICT_SMOKES.md`](../articles/plan/reference/VERDICT_SMOKES.md) — the verdict-smoke discipline doc (pending update with the eff_batch lesson + ratio-probe lesson)
- [`docs/blog/2026-05-24-v0-5-0-c-train-bisect.md`](../blog/2026-05-24-v0-5-0-c-train-bisect.md) and [`docs/blog/2026-05-24-bisect-by-elimination.md`](../blog/2026-05-24-bisect-by-elimination.md) — the public retrospectives the reviews respond to
