---
sidebar_position: 18
title: How it will work
tags:
  - architecture
  - reference
  - neural
  - hybrid
  - training
  - corpus
  - tokenizer
  - ja-jp
---

# How it will work — the near future

This article describes where Mailwoman is heading. The work is tracked in GitHub issues and the [`plan/`](../../plan/README.md) directory. Status is current as of May 2026.

## What shipped: v0.4.0 through v0.5.0 scaffolding

### v0.4.0 (shipped May 2026)

The v0.4.0 ablation campaign attempted to combine three training improvements — per-token CRF normalization, class-weighted cross-entropy, and source-weight rebalance — into one release. Five of six training runs diverged. The shipped checkpoint (`v0_4_0-stableLR-source-only/step-002200`) uses only source-weight rebalance layered on v0.3.0's existing recipe.

Key outcomes:

- **Source rebalance works.** NAD downweight (2.0 → 1.0) and WOF promotion (1.0 → 2.0) trains stably.
- **Fine labels improved slightly.** `street` 0.27 → 0.30, `house_number` 0.78 → 0.79.
- **Postcode regressed.** 0.76 → 0.69, driven by NAD downweight removing "postcode-first" positional patterns from training.
- **Country F1 regression is mostly an eval artifact.** 92% of country false-negatives are adversarial transliteration entries the model was never trained for.
- **JS-side Viterbi decoder shipped.** CRF with frozen mask now runs in the browser.
- **Verdict-smoke discipline hardened.** Constant-LR smokes and full-run effective-batch matching prevent the cosine-LR meta-bug that hid v0.4.0's divergence.

### v0.5.0 scaffolding (shipped May 2026)

The v0.5.0 "fresh-slate" bundle shipped five of six planned threads to `main`:

| Thread | Component                                                             | Status                                                       |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| A0     | Tokenizer harness + A0 baseline weights                               | Shipped                                                      |
| A1     | Tokenizer retrain on corpus-v0.4.0                                    | Trained; not yet used in stable classifier                   |
| B      | Kryptonite catalogue (4,771 adversarial rows)                         | Shipped                                                      |
| B2     | Transliteration pairs (~73K US/FR → CJK/Cyrillic/Hangul/Han/Armenian) | Shipped                                                      |
| C-s    | Classifier code path (top-k inference + phrase-prior conditioning)    | Scaffolded in `main`; full train (C-train) pending stability |
| D-s    | Stage 5 reconcile (joint decoding with concordance scoring)           | Shipped, opt-in behind feature flag                          |
| E      | Phrase grouper (Stage 2.7, rule-based)                                | Shipped as `@mailwoman/phrase-grouper`                       |
| F      | Verdict-smoke discipline                                              | Shipped (`VERDICT_SMOKES.md`, `--smoke-mode constant`)       |

The A1 tokenizer halved byte-fallback on multi-script addresses (36.7% → 18.2%). The phrase grouper and joint decoder close the two architectural gaps v0.4.0 exposed. The kryptonite catalogue gives the training pipeline an adversarial validation set.

## What is in progress: training stability

The C-train — the full classifier training run that would produce v0.5.0 weights — has not converged. Four training attempts using the v0.5.0 recipe all diverged with the same fingerprint seen in v0.4.0: loss descends through warmup, bottoms out, then climbs catastrophically under sustained peak learning rate.

The May 2026 diagnostic work identified that the **CRF-NLL term dominates the CE term** by 8-20× in gradient magnitude. This is the opposite of what the v0.4.0 campaign assumed (it hypothesized CRF gradient collapse, not CRF gradient dominance). The current experiment is **CE-only training**: remove the CRF loss term entirely, train on cross-entropy alone, keep the CRF as an inference-time structural decoder with the frozen mask.

Resolution path:

1. **CE-only smoke (in progress).** 2,000-step constant-LR run with `crf_loss_weight=0.0`. Gate: no loss climb past step 2,000 AND val_macro_f1 ≥ 0.35.
2. **If CE-only stable → full 50K C-train.** Quality ceiling TBD — the win is stability, not quality. Quality gains come from recipe knobs (class weights, source weights, longer training) that were unsafe under dual-loss.
3. **If CE-only diverges → bisect tokenizer/corpus.** A1 tokenizer + corpus-v0.4.0 vs v0.1 tokenizer + corpus-v0.4.0. Isolate the destabilizer.
4. **Parallel: reconcile integration.** Wire joint decode as the default Stage 5 path behind a feature flag. Evaluate against kryptonite catalogue + golden v0.1.2. Gate: +15pp exact-match on kryptonite, ≤1pt macro_F1 regression on golden.

## Beyond training: the integration horizon

Once stable training is achieved, the next steps:

### Joint decode as default

The reconciler (Stage 5) currently operates behind an opt-in flag. Wiring it as the default path requires:

- TS-side per-span logit aggregation (softmax over phrase-grouper spans) to feed top-K to the reconciler.
- Evaluation against the kryptonite catalogue (NY-NY Steakhouse, Paris TX, St. Petersburg FL).
- A/B comparison of joint-decode vs argmax fallback on golden v0.1.2.

### v0.5.1 and beyond

| Milestone              | What it adds                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Learned phrase grouper | 1-2M-param span proposer trained on segment boundaries. Replaces the rule-based grouper.           |
| Tier 3 label expansion | `attention`, `po_box`, richer POI taxonomy. Requires corpus adapter updates.                       |
| top-k Resolver API     | Multi-candidate resolver output surfaced in CLI + demo. "Springfield" shows IL, MA, MO candidates. |
| Phase 5 — Studio       | Web UI for human correction of parses. Corrections feed into retraining.                           |
| Phase 6 — Japan        | Japanese address validation. Architecture stress test — no streets, block-based addressing.        |

### What stays the same

- **Rule classifiers are not replaced.** They stay deterministic, fast, and reliable. The neural classifier earns each component one at a time.
- **The model stays small.** The transformer is staying at roughly 9 million parameters. The win comes from better architecture (phrase grouper, joint decode) and better training, not from scaling up.
- **Browser support is a hard constraint.** The pipeline must stay under ~60MB cold load. The demo is the canary.
- **Locale parity is tracked but not urgent.** The en-us model has had the most attention. fr-fr will catch up, ja-jp is the validation stress test.

## What we are not doing

- **Multi-language understanding.** We are not training a model that reads prose in 50 languages. We are training one that labels tokens in addresses for the locales we ship.
- **Generative output.** The neural classifier labels existing tokens. It does not write text.
- **Replacing upstream projects.** Mailwoman uses Pelias, libpostal, OSM, WOF, and other open data as sources and inspiration. It is a complementary project, not a competitor.

## See also

- [v0.4.0 blog post](pathname:///blog/2026-05-23-v0-4-0-ablation-campaign) — the ablation campaign retrospective
- [v0.5.0 blog post](pathname:///blog/2026-05-24-v0-5-0-c-train-bisect) — the C-train divergence and bisect
- [The knowledge ladder](./the-knowledge-ladder.md) — the staged decomposition design
- [Implementation plan](../../plan/README.md) — the full phase roadmap
