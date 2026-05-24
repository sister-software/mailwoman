# Phase 8 — v0.5.0 fresh-slate iteration

**Goal:** retire the inherited debt from v0.1.0 by rebuilding tokenizer + model + corpus + pipeline architecture together, in one coordinated iteration. This is the **sharpened-axe** ship: pay one big cost to clear several structural ceilings at once, rather than spending incremental ships patching around them.

**Cadence:** ~3-6 weeks wall-clock, depending on training compute budget. With rented GPU this compresses; on local iGPU it does not.

**Branch convention:** `feat/v0.5.0-fresh-slate` umbrella; per-component sub-branches as the work decomposes.

**Depends on:** v0.4.0 shipped (it has — 2026-05-23). Issue #116 retrospective written. v0.4.1 explicitly NOT done first — operator decision 2026-05-23 was to skip the incremental warm-start in favor of fresh-slate.

**Language:** Python for training (`packages/corpus-python/`), TypeScript for runtime pipeline + new stages.

## Why fresh-slate

v0.4.0 shipped a `§4-only` recipe after the full §1+§3+§4 destabilized at every tested learning rate. The campaign's deeper finding wasn't about §1 or §3 specifically — it was that the training-side improvements we were trying to bolt onto v0.3.0 weights ran into architectural constraints we had inherited from v0.1.0:

- **Tokenizer locked at v0.1.0** — byte-fallback on non-Latin scripts drives 92% of country FN, 18% of postcode FN. No model-side fix possible without retraining the tokenizer, which forces a fresh model train.
- **Single classifier head doing both boundary discovery and type classification** — BIO labeling couples these two problems; v0.4.0's bio_slip slice (6% of postcode FN) is the symptom. A phrase-grouping layer (new Stage 2.7) decouples them, but its outputs need to flow into the classifier's conditioning — which requires a classifier retrained to use them.
- **Stage 5 reconcile is structural-only today** — sorts spans, attaches via PARENT_OF. To do real concordance matching (`NY-NY Steakhouse, Houston, TX`, `Paris, Texas`, `Saint Petersburg`) it needs top-k from classifier + top-k from resolver + concordance scoring. The classifier needs to emit top-k by design, not just argmax.

These three changes individually would each require either a fresh train or a meaningful runtime rewrite. Doing them together is roughly the same cost as doing the most expensive one alone, with much higher leverage.

## Scope decomposition

Six work areas, each with its own thread. Cross-thread dependencies noted.

### A. Tokenizer retrain — multi-script + adversarial coverage

- **What:** new sentencepiece tokenizer trained on corpus + synthetic transliteration pairs (DeepSeek-generated, see Thread B). Vocab budget 48K-64K (up from current 32K) to accommodate non-Latin sub-pieces with low byte-fallback.
- **Why:** closes the 92% country FN driven by byte-fallback. Enables ja-JP / ko-KR / zh-CN / ru-RU model expansion in v0.6.0+ without another tokenizer fork.
- **Specifics:**
  - Target: < 5% byte-fallback on a balanced multi-script eval slice
  - Hand-crafted "must keep whole" rules for known postcode formats (5-digit ZIP, UK postcodes, JP `100-0005`, etc.) — uses sentencepiece user-defined symbols
  - Train on the SAME corpus the model will train on (consistency)
- **Output:** `/data/models/tokenizer/v0.5.0/` + new model card
- **Blocks:** Threads C (classifier needs new tokenizer to embed against) + E (phrase grouper benefits from cleaner sub-pieces).
- **Blocked by:** Thread B (synthetic adversarial corpus must be generated first; tokenizer trains on the combined corpus).

### B. Synthetic adversarial corpus expansion

- **What:** use DeepSeek (or comparable LLM) to generate transliteration pairs and incongruent-component examples. Add to `corpus-v0.4.0` (next corpus revision; bumps from v0.3.0).
- **Why:** golden v0.1.2 evaluates against adversarial transliterations the model was never trained on. Either we close the train/eval gap or we admit the eval is measuring out-of-distribution and weight the regression denominator accordingly.
- **Specifics:**
  - **Transliteration pairs**: generate N (target ~50K) US/FR addresses with their CJK/Cyrillic/Armenian script transliterations. Both as input → English gold pairs AND as augmented training rows for the existing en-US/fr-FR classifiers.
  - **Kryptonite generation**: prompt-engineer DeepSeek to produce the operator's kryptonite catalogue at scale — `Buffalo Buffalo`, `NY-NY Steakhouse, Houston, TX`, `Saint Petersburg, FL`, `Paris, Texas`, mid-position postcodes, etc. Target 5-10K such examples with annotated correct parses.
  - **License hygiene**: DeepSeek outputs are AGPL-compatible for our use case. Document the generation pipeline + prompts so the corpus is reproducible.
- **Output:** `corpus-v0.4.0` (added to `corpus-v0.3.0` rows, not replacing). Pure adapter additions; existing weights remain valid.
- **Blocks:** Threads A, C.
- **Blocked by:** nothing — can start immediately.

### C. Classifier with top-k output + phrase-prior conditioning

- **What:** retrain the BIO classifier with two structural changes:
  - **Top-k by design**: instead of always returning argmax, the inference path returns top-k tag sequences with calibrated scores. Stage 5 consumes these.
  - **Phrase-prior conditioning**: classifier input layer takes the phrase grouper's proposed spans as additional features (one-hot or learned-embedding for "this token is the start of a proposed phrase," "this token is mid-phrase," etc.). Trained jointly with the BIO objective.
- **Why:** unblocks Stage 5 concordance work. The model becomes a candidate generator instead of a single-answer predictor — matches the architecture's contract.
- **Specifics:**
  - Likely a hidden_size bump (256 → 384 or 512) — paid for by rented GPU. Validate before committing.
  - Label vocabulary unchanged from v0.3.0 (21 BIO classes) unless POI taxonomy expansion is bundled in (operator decision).
  - Training on corpus-v0.4.0 (adversarial-expanded). Tokenizer is v0.5.0.
  - Use the lessons from v0.4.0: verdict smokes with constant-LR or long max_steps (not cosine-decay). One change at a time within this fresh-slate ship — don't try to combine §1 per-token CRF norm AND §3 class weights AND phrase priors in a single run. The phrase priors are the headline change; everything else stays as-close-to-v0.3.0 as possible.
- **Output:** new `neural-weights-en-us@v0.5.0` + `neural-weights-fr-fr@v0.5.0` packages.
- **Blocks:** Thread D (Stage 5 needs top-k classifier output).
- **Blocked by:** Threads A + B + E.

### D. Stage 5 reconcile — concordance matching via joint decoding

- **What:** Stage 5 expanded from "sort spans by start" to "Viterbi over (span proposal × tag interpretation × resolver candidate)." Picks joint-coherent parse trees that maximize `phrase_grouper_confidence × classifier_confidence × resolver_score × concordance_bonus`.
- **Why:** closes the kryptonite catalogue. Currently the system has no layer that knows whether a parse is internally consistent; reconcile is supposed to be that layer.
- **Specifics:**
  - New file `core/pipeline/reconcile.ts` (Stage 5 implementation; sibling to `runtime-pipeline.ts`)
  - Concordance scoring uses WOF parent_id chains: a country/region/locality assignment is coherent iff their `parent_id` chain agrees in the gazetteer
  - Configurable trade-off weights (`concordanceWeight` opt) so callers can tune classifier-trust vs gazetteer-trust
  - Test surface: a fixture file of the operator's kryptonite catalogue with expected parses pre- and post-reconcile
- **Output:** runtime change; no model retraining. Ships in `@mailwoman/core` as part of the v0.5.0 npm package family.
- **Blocks:** none.
- **Blocked by:** Thread C (needs top-k output to consume), Thread E (needs phrase proposals to consume).

### E. Stage 2.7 phrase grouper

- **What:** new pipeline stage between kind classifier and neural classifier. Proposes coherent input units with confidence scores. Ships in two flavors:
  - **Rule-based** first (port of v1's section/sub-section logic): proximity, punctuation, capitalization, hyphenation. Deterministic, no training, fast.
  - **Learned** later (small 1-2M param span proposer trained on segmentation labels derived from corpus). Validates whether learned generalization beats rules.
- **Why:** decouples boundary discovery from type classification — addresses v0.4.0's bio_slip slice at source rather than via decoder post-trim. Feeds both Stage 3 (as input conditioning) and Stage 5 (as span candidates).
- **Specifics:**
  - New workspace `@mailwoman/phrase-grouper/` alongside `@mailwoman/locale-gate` + `@mailwoman/kind-classifier`
  - Output: `Array<{ span: Section; kindHypothesis: PhraseKind; confidence: number }>`
  - PhraseKind taxonomy includes NUMERIC, STREET_PHRASE, LOCALITY_PHRASE, REGION_ABBREVIATION, POSTCODE, VENUE_PHRASE, HYPHENATED_COMPOUND
  - Rule-based version ships first as proof-of-concept; learned version is v0.5.0 stretch if time permits, otherwise v0.5.1
- **Output:** new workspace + new stage in `runPipeline`. Existing pipeline behavior unchanged when caller does not opt in (backward-compatible).
- **Blocks:** Thread C (classifier conditioning), Thread D (reconcile consumes proposals).
- **Blocked by:** nothing — rule-based version can start immediately.

### F. Process improvements landed during v0.4.0 to harden — **SHIPPED**

- **Status:** shipped 2026-05-23 (branch `feat/v0.5.0-thread-f-verdict-smokes`).
- **What:** carry the v0.4.0 sidecars + diagnostic tools into the v0.5.0 process from day one.
  - `corpus-audit` already in tree (`corpus/scripts/audit.ts`) — runs cleanly against `corpus-v0.3.0`. Use it to verify Thread B's corpus mix before tokenizer training and before classifier training.
  - `diagnose_regression.py` already in tree (`corpus-python/scripts/diagnose_regression.py`) — use it for v0.5.0 eval bucketing, not just post-hoc.
  - Verdict-smoke framework redesigned: **constant LR for the smoke window**, OR `max_steps >= 10000` so the cosine tail doesn't dominate. Documented in [`VERDICT_SMOKES.md`](../reference/VERDICT_SMOKES.md). Code enforcement: `--smoke-mode constant|long-tail` on `python -m mailwoman_train train` and `smoke` subcommands; defaults to constant for end-to-end smokes.
  - Decoder span-trim sidecar (commit `c72ab4c`, `core/decoder/build-tree.ts:58`) stays in main — covers the long tail of bio_slip cases the phrase grouper might miss.
- **Why:** v0.4.0's process meta-bug (cosine LR masking divergence) cost real iteration cycles. Document the lesson so v0.5.0 doesn't repeat it.
- **Output:** new [`VERDICT_SMOKES.md`](../reference/VERDICT_SMOKES.md) + `--smoke-mode` CLI flag + updated TODO.md.

## Cross-thread execution order

Critical path (must complete sequentially):

```
B (corpus expansion) → A (tokenizer) → C (classifier)
                                          ↘
E (phrase grouper, rule-based)             → D (Stage 5 reconcile)
                                          ↗
```

Parallel-safe:

- F (process improvements) ships independently throughout
- E rule-based version can ship as a standalone improvement before A/C complete (slot it into the existing v0.4.0 pipeline as an opt-in stage; backward-compatible)

## Success metrics

Different from v0.4.0's "≥2 of 4 axes" frame, because v0.5.0 is changing the architecture. Per-axis:

- **Coarse F1 (country / region / locality)**: recover to ≥ v0.3.0 baseline (country ≥ 0.28, region ≥ 0.18, locality ≥ 0.27) on the non-adversarial slice of golden v0.1.2. Stretch: improve via better phrase boundaries.
- **Fine F1 (street / house_number / venue)**: hold v0.4.0's small wins (street ≥ 0.30, house_number ≥ 0.78, venue ≥ 0.39).
- **Non-Latin adversarial slice (new eval split)**: country F1 ≥ 0.50 (vs current ~0 — these are mostly byte-fallback empty preds). This is the tokenizer win directly measured.
- **Kryptonite catalogue (new eval fixture)**: hand-curated set of 20-30 incongruent-component cases (`NY-NY Steakhouse`, etc.). Target: 80%+ resolved to the correct place via Stage 5 reconcile.
- **Training stability**: zero divergence runs in the v0.5.0 verdict-smoke + full-train sequence. Verdict-smoke redesign should make this enforceable.
- **Calibration**: ECE ≤ v0.3.0 baseline.

## Pre-flight

- [ ] DeepSeek API access confirmed + rate-limit budget understood
- [ ] Rented-GPU pricing + provisioning understood (a single H100 day for the full train is likely sufficient; phrase-grouper learned-version is small and can run on local iGPU)
- [ ] `corpus-v0.3.0` integrity verified before adapter additions
- [ ] Tokenizer training pipeline reproducible end-to-end on a fresh clone
- [ ] `mailwoman corpus-audit` runs cleanly against the planned corpus-v0.4.0 mix

## Out of scope for v0.5.0

- New language packs beyond en-US / fr-FR. ja-JP / ko-KR / zh-CN etc. wait on either v0.6.0 or v0.5.x patch releases AFTER the tokenizer + reconcile layer are validated in production.
- POI taxonomy expansion (Stage 3 label vocab expansion). Stays at v0.3.0's 21 BIO classes. v0.6.0+ work.
- Web demo redesign. Existing browser demo at `/demo` works on v0.5.0 weights as-is via onnxruntime-web.
- Resolver backend changes. WOF SQLite stays primary; remote-resolver (Pelias / BAN / Nominatim) is still v0.6.0+ work.

## Wall-clock estimate (rented GPU)

- B (corpus + DeepSeek generation): 3-5 days. Mostly LLM-API time + corpus integrity checking.
- A (tokenizer retrain): 1-2 days once corpus ready. Sentencepiece training is fast.
- E rule-based (phrase grouper): 2-3 days. Most time is fixture-writing + tuning.
- C (classifier retrain): 3-5 days. Single full 50K run on rented H100 should converge cleanly with the v0.4.0 process improvements in place; verdict-smoke + full-train.
- D (Stage 5 reconcile): 5-7 days. Most time is correctness work on the kryptonite catalogue.
- E learned (phrase grouper, if pursued): 3-5 days. Stretch — can defer to v0.5.1.
- F (process improvements): inline.

**Total: 3-4 weeks with overlap, 5-6 weeks sequential.**

## Decision log

- 2026-05-23: Operator chose fresh-slate (v0.5.0 fork) over incremental (v0.4.1 warm-start) after the v0.4.0 mixed-result postmortem. Rationale: the cost of bundling tokenizer retrain + phrase grouper + reconcile expansion is one big iteration vs three medium ones, and the resulting architectural ceiling is meaningfully higher. Rented GPU + DeepSeek-generated adversarial corpus make the previously-prohibitive parts tractable.
- 2026-05-23: Synthetic adversarial corpus is in scope (Thread B). License hygiene confirmed: DeepSeek-generated content is acceptable for our use case under AGPL.

## See also

- [The knowledge ladder](../../understanding/the-knowledge-ladder.md) — conceptual framing for what the missing rungs do
- [The pipeline contract](../../concepts/staged-pipeline-contract.md) — runtime mechanics
- [v0.4.0 ablation campaign retrospective](../../retrospectives/v0-4-0-ablation-campaign.md) — what made the fresh-slate decision necessary
- [Issue #116](https://github.com/sister-software/mailwoman/issues/116) — v0.4.0's original work plan
