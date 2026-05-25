# Phase 8 Thread E — learned span proposer (v0.5.1 candidate)

**Status:** scoped, not implemented. v0.5.0 ships the rule-based phrase grouper (`@mailwoman/phrase-grouper`); this doc lays out the learned counterpart for v0.5.1 (or v0.5.0 stretch, time permitting).

**Branch / package convention:** `feat/v0.5.1-learned-span-proposer`; new workspace `@mailwoman/phrase-grouper-learned` (or extension of the existing workspace gated by an env / opts flag).

**Depends on:** Thread B (synthetic adversarial corpus with span-boundary labels) + Thread A (tokenizer v0.5.0). Cannot start until both are landed.

## Why a learned version

The rule-based v1 covers the common shapes (NUMERIC, STREET_PHRASE, LOCALITY_PHRASE, REGION_ABBREVIATION, POSTCODE, VENUE_PHRASE, HYPHENATED_COMPOUND) at predictable, explainable cost. Its blind spots are:

- **Inputs without capitalization cues** — all-lowercase OCR output, voice-to-text, autocomplete mid-typed input. The rule pack leans heavily on capitalization as the LOCALITY_PHRASE / VENUE_PHRASE signal.
- **Non-Latin scripts** — CJK / Cyrillic / Arabic don't have a capitalization signal at all. Rule packs would need per-script hand-crafted alternatives; a learned model trained on a multi-script corpus generalizes for free.
- **Compositional novelty** — `NY-NY Steakhouse` works because both `NY-NY` (hyphen-compound) and `Steakhouse` (venue marker) are explicit cues. `Lou's Backyard BBQ Pit Stop` works only if `BBQ` is in the venue-marker list — and that list is unbounded.

A learned proposer is the bitter-lesson-safe answer: train a small (1-2M parameter) span-prediction model on the corpus's segment-boundary labels and let it discover the joint cues the rule pack approximates manually.

## Architecture sketch

**Input:** the same `(NormalizedInput, QueryShape, LocaleHint)` the rule version takes.

**Output:** the same `PhraseProposal[]` contract (`{ span: Section; kindHypothesis: PhraseKind; confidence: number }`). The downstream Stage 5 reconciler does not need to know which kind of grouper produced the proposals.

**Model:** small encoder-only transformer.

- **Tokenizer:** the v0.5.0 multi-script sentencepiece tokenizer (Thread A). Shared with the main classifier — no separate vocab.
- **Embedding:** ~256-dim per token. Reused from the main classifier as a starting point (LoRA / linear adapter on top), OR trained from scratch with a tied vocabulary.
- **Encoder:** 3-4 transformer blocks, hidden 256, 4 attention heads. Total ~1-2M params (a fraction of the main classifier's ~10M).
- **Heads:** two parallel heads —
  - **Boundary head:** per-token binary classifier "is this token a phrase boundary?" (BIO-shaped: begin, inside, outside).
  - **Kind head:** per-token 7-way softmax over the `PhraseKind` taxonomy. Predicted at the begin-token of each proposed phrase.
- **Decoding:** Viterbi over the boundary head emissions, then read off `kindHypothesis` at each phrase's begin token. Top-k proposals (configurable, default k=5) emitted with calibrated confidence.

## Training data

Comes from Thread B (corpus-v0.4.0). Two sources:

1. **Derived labels from the existing BIO corpus.** Each contiguous run of same-tag tokens is one phrase; map the BIO tag to a `PhraseKind` via a lookup table (e.g. `B-locality ... I-locality` → LOCALITY_PHRASE). Free at training time, no new labelling required. The mapping is lossy at the edges (POI tags collapse to VENUE_PHRASE) but the lossy direction is in the structural-shape vocabulary, which is exactly what we want here.
2. **Synthetic adversarial expansion.** The kryptonite-catalogue generation pipeline (Thread B) prompt-engineers DeepSeek to produce inputs where the rule-based grouper systematically gets boundaries wrong. The learned model trains on those cases as hard negatives.

Validation: hold-out slice of the kryptonite catalogue + the v0.4.0 bio_slip slice (the 6% of cases where boundaries were demonstrably wrong in production).

## Calibration

The reconciler weighs phrase proposals against classifier proposals against resolver candidates — confidence calibration matters more here than in the rule version, because the reconciler will multiply scores. Training-time temperature scaling against the held-out kryptonite slice; report ECE on the model card alongside accuracy.

## When to ship

- **v0.5.0 stretch:** if Thread C (classifier retrain) finishes inside the GPU budget AND the rule-based grouper proves to need the assist on a meaningful slice of the eval (e.g. non-Latin queries show poor proposals). Triggered by the v0.5.0 eval, not pre-committed.
- **v0.5.1 fallback:** if v0.5.0 ships on the rule version alone. Allocate ~3-5 days of compute + engineering for the learned version once the corpus is in place.

## Out of scope for this doc

- **Multi-locale ensembling** — one model per locale vs one model handling all locales. Pre-evaluation, lean toward one shared model trained on the full multi-script corpus; the tokenizer + the encoder already do the locale-aware work.
- **Joint training with the main classifier** — could pass phrase-proposer embeddings into the classifier as conditioning. Mentioned in Thread C as the eventual integration; whether the proposer trains jointly or stays a frozen feature extractor is a v0.6.0+ question.
- **Replacing the rule version.** The rule version stays in tree as the explainable fallback + the test oracle. The learned version is additive — both can coexist behind a runtime flag, and the reconciler can consume proposals from either (or both, with source attribution).

## See also

- [`PHASE_8_v0_5_0_fresh_slate.md`](./PHASE_8_v0_5_0_fresh_slate.md) — the v0.5.0 master plan
- [`the-knowledge-ladder.md`](../../understanding/our-approach/the-knowledge-ladder.md) — where Stage 2.7 sits in the layered decomposition
- [`STAGES.md`](../reference/STAGES.md) — the formal pipeline contract
