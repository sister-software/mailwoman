# Stale-claims audit: CRF decoder + shared/multilingual model claims

Verified against the code at `/home/lab/Projects/mailwoman` on 2026-07-14. Scope: (1) `docs/articles/concepts/crf-decoder.mdx` against `corpus-python/` training code + `core/`/`neural/` runtime decode; (2) shared/multilingual-model claims across `docs/articles/` (excluding `evals/` and `retrospectives/`, which are dated point-in-time records); (3) a bounded opportunistic sweep of `docs/articles/concepts/` for other cheaply-falsifiable architecture claims.

**Ground truth, established once, cited throughout:**

- Training has been cross-entropy-only since model v0.5.0. `crf_loss_weight: 0.0` in **every** training config from `corpus-python/src/mailwoman_train/configs/v0_5_0-classifier-ce-only-full.yaml` (first CE-only config) through the current/latest `v2.9.0-country-counterweight.yaml:89` (uncommitted, today's work). `model.py:708` gates the entire CRF forward+backward pass behind `crf_loss_weight > 0`; when 0 (every current config), `model.py:748` falls through to `loss = ce_loss` — the CRF module gets **no gradient**. The shipped model card makes this explicit: `neural-weights-en-us/model-card.json:33-34` — `"crf_at_training": false, "crf_at_inference": true`.
- The shipping JS runtime decoder (`neural/viterbi.ts`) implements Viterbi over a **frozen, hand-coded BIO-structural transition mask** (`buildBIOTransitionMask`) — never learned transitions. Its own header (lines 12-20) says the learned-transition mode is "Currently not exported from the training-side ONNX bundle." `package_weights.py:104-115` (`export_crf_transitions`) confirms: returns `None` whenever `crf_loss_weight == 0.0`. No `crf-transitions.json` exists anywhere in the repo or in `neural-weights-en-us/` (confirmed by `find`).
- fr-fr ships the en-us model verbatim. `.github/workflows/publish.yml:129-131`: `# fr-fr shares the en-us model for now (locale-specific weights are future work).` followed by `cp neural-weights-en-us/model.onnx neural-weights-fr-fr/model.onnx` and the same for `tokenizer.model`. There is no fr-fr-specific training run.
- Current shipped model geometry (`neural-weights-en-us/model-card.json`, v5.9.0): `hidden_size: 384`, `num_attention_heads: 6`, `intermediate_size: 1536`, `num_labels: 33`, `params: "33.9M"`, `vocab_size: 66319`, `tokenizer_version: "0.8.0-fr-nsplice"`.

## Summary table

| #   | Claim (short)                                                                                        | Where                                                        | Severity        |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------- |
| 1   | CRF "learns" transition scores; dual CE+CRF loss described as the current training recipe            | `concepts/crf-decoder.mdx:21-26, 75-85, 87-100`              | misleads-reader |
| 2   | v3.0.0 CRF instability "fixed" in v0.4.0, no mention of permanent CE-only fallback since v0.5.0      | `concepts/crf-decoder.mdx:102-112`                           | misleads-reader |
| 3   | "computes both CE and CRF NLL when in training mode" stated unconditionally                          | `concepts/crf-decoder.mdx:124`                               | misleads-reader |
| 4   | Transition matrix "21 × 21 + 21 + 21 = 483" scalars; encoder "8.87 million parameters"               | `concepts/crf-decoder.mdx:85`                                | misleads-reader |
| 5   | `10 tags × {B-,I-} + O = 21 labels`, classifier has 21 outputs                                       | `concepts/bio-labels.mdx:53`                                 | misleads-reader |
| 6   | Model geometry table: hidden 256, heads 4, FFN 1024, ~8.87M params; mermaid diagram 256-dim/21-class | `concepts/neural-classification.mdx:32-39, 43-55`            | misleads-reader |
| 7   | Tokenizer "shipping" version is v0.1.0/16K vocab; A1/48K is "pending"                                | `concepts/tokenization.mdx:44,49,53-54,108`                  | misleads-reader |
| 8   | "the model files (one per locale)" — implies two distinct trained artifacts                          | `understanding/our-approach/from-pelias-to-mailwoman.mdx:44` | misleads-reader |
| 9   | "separate weight packages per locale... locales are first-class"                                     | `understanding/our-approach/from-pelias-to-mailwoman.mdx:53` | cosmetic        |
| 10  | "The en-us model has had the most attention. fr-fr will catch up"                                    | `understanding/our-approach/how-it-will-work.mdx:91`         | misleads-reader |
| 11  | "Mailwoman's model is per-locale (separate weights for en-US and fr-FR)"                             | `understanding/the-problem/what-is-an-address.mdx:102`       | misleads-reader |
| 12  | "published and working en-US and fr-FR model weights"                                                | `sotm-2026-talk-proposal.mdx:39`                             | misleads-reader |
| 13  | Weights bundle "under 50 KB per locale"                                                              | `sotm-2026-talk-proposal.mdx:20,25`                          | misleads-reader |

13 findings: 12 misleads-reader, 1 cosmetic.

---

## Finding 1 — CRF "learns" transitions; dual-loss training presented as current

**Claim:** "A CRF fixes this by: 1. Learning a transition score for every pair of adjacent labels... 2. At decode time, finding the highest-scoring whole sequence" and, further down, "What the CRF learns... These soft priors get baked into the transition matrix during training," followed by "How training works with a CRF": "Backpropagation through the forward algorithm trains both the encoder weights AND the CRF transition scores."

**Where:** `docs/articles/concepts/crf-decoder.mdx:21-26`, `:75-85`, `:87-100`

**Ground truth:** Training has been CE-only (`crf_loss_weight: 0.0`) in every config since v0.5.0. `model.py:708` — `if self.crf is not None and attention_mask is not None and self.crf_loss_weight > 0:` — this branch, which computes the CRF NLL and backpropagates into the transition matrix, never fires under the shipped recipe. `model.py:748` — `else: loss = ce_loss` is what actually runs. The shipped model card states this outright: `neural-weights-en-us/model-card.json:33` — `"crf_at_training": false`.

**Evidence:** `corpus-python/src/mailwoman_train/model.py:708-748`; `corpus-python/src/mailwoman_train/configs/v0_5_0-classifier-ce-only-full.yaml:58` through `v2.9.0-country-counterweight.yaml:89` (every intervening config); `neural-weights-en-us/model-card.json:33`.

**Severity:** misleads-reader — the page presents an inert module (present in the graph, never trained) as an active learning mechanism.

## Finding 2 — "v3.0.0 instability" framed as fixed, omits permanent CE-only fallback

**Claim:** "The v0.4.0 fix was to hand-weight the CRF NLL down... v0.4.0 replaces the hand-weight with per-token CRF NLL normalization... the hand-tuning goes away." The section stops there, implying CRF training stabilized and shipped from v0.4.0 on.

**Where:** `docs/articles/concepts/crf-decoder.mdx:102-112`

**Ground truth:** CRF training was reactivated post-v0.4.0 and diverged three more times before being permanently disabled. `corpus-python/src/mailwoman_train/configs/v0_6_0-stage3.yaml:66-76` — comment: "`crf_loss_weight: 0.0` after THREE divergence attempts: attempt 1 (lr=1.5e-4, crf=0.5): NaN at step 950 / attempt 2 (lr=1.0e-4, crf=0.1): NaN at step 1700 ... v0.5.4 used crf_loss_weight=0.0 (CE-only) and trained fine — match that." A subsequent fp32 diagnostic (`v0_6_2-crf-fp32-diagnostic.yaml`) tested whether bf16 precision was the cause; the next config in the lineage, `v0_6_3-house-venue.yaml:122`, is back to `crf_loss_weight: 0.0`, and every config after it stays at 0.0 through the current `v2.9.0`.

**Evidence:** `corpus-python/src/mailwoman_train/configs/v0_6_0-stage3.yaml:66-76`; `v0_6_2-crf-fp32-diagnostic.yaml:1-20`; `v0_6_3-house-venue.yaml:122`.

**Severity:** misleads-reader — the omission changes the story from "abandoned after repeated divergence" to "fixed."

## Finding 3 — "computes both CE and CRF NLL when in training mode" stated unconditionally

**Claim:** "Training-time use: `corpus-python/src/mailwoman_train/model.py` (`MailwomanCoarseEncoder.forward` computes both CE and CRF NLL when in training mode)"

**Where:** `docs/articles/concepts/crf-decoder.mdx:124`

**Ground truth:** This is gated behind `crf_loss_weight > 0` (`model.py:708`), which is `0.0` in the shipped recipe — see Finding 1.

**Evidence:** `corpus-python/src/mailwoman_train/model.py:708-748`.

**Severity:** misleads-reader.

## Finding 4 — Transition matrix size and parameter count are stale (21 labels / 8.87M params)

**Claim:** "The matrix is small: 21 × 21 + 21 + 21 = 483 learnable scalars... Negligible compared to the encoder's 8.87 million parameters."

**Where:** `docs/articles/concepts/crf-decoder.mdx:85`

**Ground truth:** The current active label set is 33 labels (`16 tags × {B-,I-} + O`), not 21. `corpus-python/src/mailwoman_train/labels.py:14` — "`STAGE3_BIO_LABELS` (33) — v0.6.0 ship, the CURRENT active set"; `labels.py:84-135` defines it; `neural-weights-en-us/model-card.json:31` — `"num_labels": 33`. The correct transition-matrix size is 33×33+33+33 = 1155 scalars. Params: `model-card.json:32` — `"params": "33.9M"`, not 8.87M. A sibling doc already has the correct label count: `concepts/how-the-model-reasons.mdx:160` — `raw emission logits per token × 33 labels`.

**Evidence:** `corpus-python/src/mailwoman_train/labels.py:14,84-135`; `neural-weights-en-us/model-card.json:31-32`; `concepts/how-the-model-reasons.mdx:160` (internal inconsistency within the same docs tree).

**Severity:** misleads-reader — cheaply falsifiable, and contradicted by a same-directory sibling page.

## Finding 5 — bio-labels.mdx: "21 labels" and an incomplete tag table

**Claim:** "10 tags × `{B-, I-}` + `O` = 21 labels. The neural model's final classifier layer has 21 outputs and the model picks the highest-probability label for each token."

**Where:** `docs/articles/concepts/bio-labels.mdx:53`

**Ground truth:** Same as Finding 4 — 33 labels, 16 tags. The doc's own tag table (lines 40-51) lists only 10 base tags (country, region, locality, dependent_locality, postcode, subregion, cedex, venue, street, house_number) and is missing 6 tags present in the shipped label set: `street_prefix`, `street_suffix`, `unit`, `po_box`, `intersection_a`, `intersection_b`.

**Evidence:** `corpus-python/src/mailwoman_train/labels.py:84-135` (full 33-entry `STAGE3_BIO_LABELS` tuple); `neural-weights-en-us/model-card.json` `labels` array (33 entries, includes the 6 missing tags).

**Severity:** misleads-reader.

## Finding 6 — neural-classification.mdx: model geometry table is stale across every dimension

**Claim:** Table: `hidden size = 256`, `attention heads = 4`, `feed-forward dim = 1024`, `total parameters = ~8.87 million`. Mermaid diagram: `"256-dim"` embeddings, classifier head `"256 → 21"`, `"21-class softmax"`.

**Where:** `docs/articles/concepts/neural-classification.mdx:32-39, 43-55`

**Ground truth:** `neural-weights-en-us/model-card.json:25,27-28,31-32` — `hidden_size: 384`, `num_attention_heads: 6`, `intermediate_size: 1536`, `num_labels: 33`, `params: "33.9M"`. Every one of the five geometry numbers in the doc's table is wrong (not just the label count from Findings 4-5) — the model has grown considerably (nsplice vocab embedding growth, more heads/width) since this table was last updated.

**Evidence:** `neural-weights-en-us/model-card.json:25-32`.

**Severity:** misleads-reader.

## Finding 7 — tokenization.mdx: shipping tokenizer version/vocab is stale

**Claim:** "Mailwoman's tokenizer was trained from scratch on the corpus. The current shipping version is **v0.1.0** (16K vocab); a new **A1 tokenizer** (48K vocab, multi-script) is validated and waiting for the CE-only classifier train to complete." Table row: `v0.1.0 (shipping) | 16,000 | ... | In production`. "Training" section: output committed to `/data/models/tokenizer/v0.1.0/`.

**Where:** `docs/articles/concepts/tokenization.mdx:44,49,53-54,108`

**Ground truth:** The currently shipped weights bundle's tokenizer is two generations past both versions named in the doc. `neural-weights-en-us/model-card.json:10,30` — `"tokenizer_version": "0.8.0-fr-nsplice"`, `"vocab_size": 66319` — 4x the "shipping" figure and 38% larger than the "validated, pending" A1 figure the doc describes as not-yet-shipped. `neural-weights-en-us/model-card.json:110` independently describes the tokenizer as "SentencePiece unigram, byte_fallback=true, vocab_size=66319 (v0.8.0-fr-nsplice = v0.7.1-nsplice + 2406 FR diacritic pieces; ships WITH the model)."

**Evidence:** `neural-weights-en-us/model-card.json:10,30,110`.

**Severity:** misleads-reader.

---

## Findings 8-13 — shared/multilingual model claims

Ground truth restated: `.github/workflows/publish.yml:129-131` — `# fr-fr shares the en-us model for now (locale-specific weights are future work).` / `cp neural-weights-en-us/model.onnx neural-weights-fr-fr/model.onnx` / `cp neural-weights-en-us/tokenizer.model neural-weights-fr-fr/tokenizer.model`. There is no fr-fr-specific training run; the two npm packages ship byte-identical model files. (Note: `concepts/neural-classification.mdx:85` — "Trained on en-US + fr-FR data, the model has internalized the conventions of both" — is the accurate framing: **one** model trained on a combined corpus, which is exactly why the packages can share a binary. The findings below are pages that instead frame it as two separate per-locale artifacts.)

### Finding 8 — "the model files (one per locale)"

**Claim:** "`@mailwoman/neural-weights-en-us` and `@mailwoman/neural-weights-fr-fr` — the model files (one per locale)."

**Where:** `docs/articles/understanding/our-approach/from-pelias-to-mailwoman.mdx:44`

**Ground truth:** Both packages ship the identical `model.onnx` (copied, not independently produced). "One per locale" reads as "one trained artifact per locale," which is false.

**Evidence:** `.github/workflows/publish.yml:129-131`.

**Severity:** misleads-reader.

### Finding 9 — "separate weight packages per locale... locales are first-class"

**Claim:** "**Multi-locale design.** Mailwoman ships separate weight packages per locale (en-us, fr-fr) and the architecture is built around the idea that locales are first-class."

**Where:** `docs/articles/understanding/our-approach/from-pelias-to-mailwoman.mdx:53`

**Ground truth:** "Separate weight packages" is literally true (two distinct npm packages exist and are independently distributable/versionable); it doesn't claim the _contents_ differ. Lower-confidence finding than 8, 10, 11 — flagged because it sits one line below Finding 8 and reinforces the same impression, but the literal words are defensible.

**Evidence:** `.github/workflows/publish.yml:129-131`.

**Severity:** cosmetic.

### Finding 10 — "fr-fr will catch up"

**Claim:** "**Locale parity is tracked but not urgent.** The en-us model has had the most attention. fr-fr will catch up, ja-jp is the validation stress test."

**Where:** `docs/articles/understanding/our-approach/how-it-will-work.mdx:91`

**Ground truth:** There is no independent fr-fr training track to "catch up" — fr-fr's weights are a direct copy of en-us's. The gap this sentence describes (fr-fr lagging en-us in attention) doesn't exist in the form described; what exists is a policy decision not to train fr-fr separately yet.

**Evidence:** `.github/workflows/publish.yml:129-131`.

**Severity:** misleads-reader.

### Finding 11 — "separate weights for en-US and fr-FR" as supporting evidence for the per-locale-grammar argument

**Claim:** "Mailwoman's model is per-locale (separate weights for en-US and fr-FR; Japan is a planned future locale) precisely because there is no universal address grammar."

**Where:** `docs/articles/understanding/the-problem/what-is-an-address.mdx:102`

**Ground truth:** The weights are not separate — identical binary, copied at publish time. This is the most directly falsifiable instance because the (false) claim is used as load-bearing evidence for an architecture argument a reader might repeat.

**Evidence:** `.github/workflows/publish.yml:129-131`.

**Severity:** misleads-reader.

### Finding 12 — "published and working en-US and fr-FR model weights"

**Claim:** "Mailwoman is in active development with published and working en-US and fr-FR model weights."

**Where:** `docs/articles/sotm-2026-talk-proposal.mdx:39`

**Ground truth:** Literally true in isolation (both packages are published and both work), but in the context of a conference talk proposal about the neural architecture, it invites the inference that two independently-trained, locale-specialized models exist. They don't.

**Evidence:** `.github/workflows/publish.yml:129-131`.

**Severity:** misleads-reader.

### Finding 13 — weights bundle "under 50 KB per locale" (bonus, same page)

**Claim:** "keeping the entire weights bundle under 50 KB per locale" (abstract) and "keeps model size under 50 KB per locale" (talking point #2).

**Where:** `docs/articles/sotm-2026-talk-proposal.mdx:20, 25`

**Ground truth:** The shipped int8 bundle is ~36.8 MB, not 50 KB — off by roughly three orders of magnitude. `neural-weights-en-us/model.onnx` is 36,787,564 bytes on disk; `neural-weights-en-us/model-card.json:114` — `"int8_size_mb": 36.8`. Not strictly a locale-sharing claim (it would be wrong even if fr-fr had its own model), but it repeats the same "per locale" framing on the same page as Finding 12, so flagged alongside it.

**Evidence:** `neural-weights-en-us/model-card.json:113-114`; `ls -la neural-weights-en-us/model.onnx` (36,787,564 bytes, dereferenced through the dev symlink).

**Severity:** misleads-reader.

---

## Notes on scope discipline

- `docs/articles/plan/phases/PHASE_2_training.mdx:161` and `PHASE_6_japan.mdx:57` discuss per-locale vs. shared-model tradeoffs as **open roadmap questions**, not claims about current state — not flagged.
- `docs/articles/concepts/language-support.mdx` (the locale-support page) was read in full and is carefully hedged throughout — it never claims separate trained weights beyond en-US/French, and its "coordinate-paneled" tier language is consistent with one shared model evaluated per locale. Not flagged.
- `docs/articles/concepts/how-the-model-reasons.mdx:134` hedges learned-CRF-transitions correctly ("If learned CRF transitions are present (v0.6.4+ with `crf_fp32=true`)...") and already uses the correct 33-label count (line 160) — cited above as the accurate contrast, not flagged as a finding.
- `docs/articles/concepts/attention-and-bidirectional-context.mdx:83-84` and `concepts/what-mailwoman-is.mdx:30` mention BiLSTM/LSTM only as historical NLP lineage comparisons ("the CLOSEST formal analog in classical NLP is... BiLSTM-CRF → BERT token classification → this"), not as claims about Mailwoman's own architecture — not flagged.
- `evals/` and `retrospectives/` excluded per task scope (dated, point-in-time). `reviews/` was not excluded by the task but is also dated/point-in-time by construction; its few "locale-specific weight packages" mentions were reviewed and judged low-signal (feature-name references, not architecture claims) and not written up.
- Did not chase the "677-million-row corpus" figure (`understanding/our-approach/from-pelias-to-mailwoman.mdx:41`) — no authoritative row-count field exists in `model-card.json`'s `training` block to cheaply verify it against; out of the "cheap to check" bound for the item-3 sweep.
