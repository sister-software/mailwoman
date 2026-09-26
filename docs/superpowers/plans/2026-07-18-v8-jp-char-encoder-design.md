# v8 JP char-path — input-interface design + Leg-1 probe (Fable, 2026-07-18)

This design refines `scratchpad/v8-cjk-architecture-plan.md`. It is based on reading model.py (CharCNNEmbedding 133–192, forward fusion 563–660), char_tokenizer.py, data_loader.py, tokenizer.py (char-label implementation 113–257), labels.py, the SCHEMA.mdx JP block, and the Phase-0 derisk results.

## Decision register (4 irreversible)

| #   | Decision                                                                                                                                          | Reversibility                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D1  | Tensor interface `char_ids (B,S,W)` where **S = label units, W = char composition window** — one interface for Latin char-word and CJK char-level | **Irreversible** (ONNX signature; neural/ + neural-web/ reimplement byte-for-byte) |
| D2  | Char vocab = sealed codepoint-sorted JSON, built from train split, shipped in weights pkg                                                         | **Irreversible** per model (past tokenizer-mismatch bug)                           |
| D3  | CJK unit = **one character** (not morpheme-grouped); per-char BIO                                                                                 | **Irreversible** (codifies TS decoder JP span reconstruction)                      |
| D4  | JP compact `2-3-16` = **one house_number span**; JP-seven fine tags reserved for kanji-designator forms only                                      | Hard to reverse (changing it requires an extract rebuild)                          |
| D5  | Leg-1 probe trains on universal STAGE3 subset (region/locality/street/house_number/postcode) rather than JP-seven                                 | Reversible (probe-scoped)                                                          |
| D6  | Context window `ctx_chars=3` for CJK (W=7), `ctx_chars=0` for Latin char-word                                                                     | Config knob, ablatable                                                             |

## (a) Interface

`CharCNNEmbedding.forward` maps `char_ids (B,S,W)→(B,S,hidden)` and does not depend on what a "position" means. That makes one interface serve both scripts. **S counts label units** (each unit carries one BIO label), and **W holds the chars that describe that unit**. For Latin char-word, a unit is a whitespace token and W holds the token's chars (ctx=0). For CJK char-level, a unit is one char and W holds that char plus its ±3 neighbors (W=7). With W=1 the multi-width CNN degenerates, because kernels 3/4/5 see one char plus padding. W=7 lets it detect local n-grams such as 丁目, 番地, and 号 at negligible cost. For CJK, a window of neighboring chars takes the place that a word's chars take for Latin.

Probe shapes:

- `char_ids (B,S=96,W=7) int64`. Slot j holds `char_to_id[raw[s−3+j]]`. Off-unit and out-of-bounds slots are PAD 0, and unseen chars are UNK 1.
- `attention_mask (B,S)`.
- `labels (B,S)` holds per-unit BIO, with IGNORE −100 on padding.

S=96 counts chars, and JP rows are about 15–70 chars long. `MailwomanCoarseEncoder.forward` needs no change, because its `use_char_embed` branch already derives `(bsz,seq)` from `char_ids.shape`. The encoder pad-mask (183–190) already handles edge windows.

Add `char_tokenizer.encode_row_units(raw, unit_spans, char_labels, char_to_id, max_units, max_unit_width, ctx_chars)`. **`tokenizer.char_label_array_from_spans` (tokenizer.py:153) already emits the per-char BIO that the CJK path needs.** For CJK, `unit_spans=[(i,i+1)...]`, so the per-unit labels are the per-char array without projection. For Latin, `unit_spans=whitespace_spans`, and B/I labels are re-derived per unit. `encode_row_charword` stays for frozen-probe reproducibility and becomes a thin wrapper over `encode_row_units(ctx=0)`.

data_loader wiring:

- Add `DataConfig.char_mode: "off"|"word"|"char"` (default off), plus `char_vocab_path`, `char_ctx`, and `max_unit_width`.
- Add `EncodedExample.char_ids`.
- Add a char branch at `iter_encoded` (549). It skips SentencePiece and calls `char_label_array_from_spans` and then `encode_row_units`. **The branch requires span-schema extracts** and raises on token-only extracts.
- Collate emits `char_ids` as `(B,S,W)`.

**The anchor, gazetteer, and country channels stay off for the probe.** Re-aligning them per unit is post-probe work. The char vocab (D2) comes from `build_char_vocab` over the JP train split with min_count=2. It should hold about 3–5k entries. At embed_dim 64 that is about 0.3M params, compared with 28M for SentencePiece, which confirms that the char model is smaller. Runtime char→id mapping, unitization, and windowing are v8 ship items. **The probe check is evaluated entirely in Python.**

## (b) Unification: one code route, two trained artifacts for v8, defer single-model to v9

1. **The code path is unified (D1).** The only fork is data-side segmentation (`whitespace_spans` versus per-char), and both branches feed the same `encode_row_units`, CharCNN, and ONNX signature. Two routes would add no value. The design is safe for v9 because the plumbing never forks.
2. **v8 ships separate trained artifacts, routed by script.** The Latin SentencePiece model stays byte-identical, so its regression is provably zero. The router computes a Unicode-block histogram in query-shape. A CJK-dominant query goes to the char model, and every other query goes to the SentencePiece model.
3. **Whether one char model can serve all scripts is an open question, and Leg 2 answers it cheaply.** Leg 2 trains a bare char model (ctx=0, char-word) on the Latin corpus and compares it with bare SentencePiece on the Latin coord boards. If they match within noise, v9 considers unification, which means one artifact, dropping the router, and cross-script transfer. The costs are Latin dilution (seen in #825), loss of the provable-zero regression, and multilingual balancing. Unification is a v9 decision that needs a measured receipt. It is never the v8 default.

## (c) JP number (D4): whole-span house_number

The compact form `2-3-16` is tagged as a single house_number. The kanji-designator long form (2丁目3番16号) is split into block, sub_block, and building_number only once it enters the corpus (Phase 2+).

The compact form carries no per-part surface evidence. The role of each part depends on the part count and on a preceding 丁目, which is deterministic arithmetic rather than per-token ambiguity. The model should not have to learn that arithmetic. The sub-part split happens at resolve time and is fully recoverable from the span text and part count. The long form carries its designators in the surface text, where the kanji is per-char-taggable evidence, so it gets the declared fine tags. Each surface form therefore gets its own rule.

For the probe, the Overture-JP number field is compact, and the Phase-0 aligner emits it as one span. The probe therefore runs on the existing STAGE3 head with no schema work and stays comparable to the bare-Latin floor. The formatter match-key normalizes both forms to the same chōme/banchi/go at resolve time.

## (d) Leg-1 probe

Model: a fresh MailwomanCoarseEncoder with Latin-substrate geometry (hidden 384, 4 layers, STAGE3 33-label), `use_char_embed`, the JP char_vocab, and ctx=3/W=7/S=96. The probe runs without the anchor, gazetteer, country, and phrase channels and without a CRF, and it uses a fresh position table.

Run: `v8-jp-probe.yaml` on the standing Modal path, never under a shell timeout. About 8k steps take about 1 A100-hour.

Corpus: about 200k JP rows drawn from the 19.6M on-disk Overture-JP rows via locale-recipe.

- source=overture-jp, span-triple (#519), aligned by align.ts (verified in Phase 0).
- Stratified across the 46 prefectures, with an urban-chōme fraction.
- Native large-to-small order, space-free, plus a 〒postcode fraction.
- **The country-intl fraction belongs to the Phase-3 full extract rather than the probe**, because country is not on the probe board.

Extract sanity checks: no all-O rows, raw BIO coverage (the JSON view has hidden coverage gaps in the past), and per-prefecture counts.

Held-out board: 1.5–2k rows held out by municipality bucket, so its localities are unseen in training.

Score: Parse and resolve region and locality (plus street and number) through the JP admin gazetteer, then measure coordinate acceptability with the coord-parity harness. WOF-JP point geometry at prefecture, county, and ward level plus municipality centroids is sufficient.

**Check (pre-registered): bare-char-JP coord acceptability ≥ 0.70 (the bare-Latin floor).** If the probe passes, proceed to Phase 2 (JP-seven activation, a 33→47 head with its own param-group LR per #727) and Phase 3 (full extract, with channels re-aligned per unit). Run Leg 2 in the same session.

If the probe fails, diagnose before proceeding:

1. Per-tag split: If street and house_number are strong and region and locality are weak, the model has an unseen-kanji generalization gap. The gazetteer channel then moves up in priority, and the result is not a verdict on the encoder.
2. Boundary audit: If spans are off by 1–2 chars, suspect windowing or BI decoding. Run a ctx ablation and a per-char argmax dump.
3. Collapse: Suspect a loader or vocab bug. Check the raw BIO and the `char_ids` of a hand-decoded row.

A failure rules out only the claim that a bare char-level CharCNN alone reaches the Latin floor on JP. It does not rule out char plus channels, more data, or a wider window. It also cannot implicate alignment, which Phase 0 verified at 1560/1560.
