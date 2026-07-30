# v8 JP char-path — input-contract design + Leg-1 probe (Fable, 2026-07-18)

Refines `scratchpad/v8-cjk-architecture-plan.md`. Grounded in model.py (CharCNNEmbedding 133–192, forward fusion 563–660), char_tokenizer.py, data_loader.py, tokenizer.py (char-label machinery 113–257), labels.py, SCHEMA.mdx JP block, Phase-0 derisk.

## Decision register (4 irreversible)

| #   | Decision                                                                                                                                        | Reversibility                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D1  | Tensor contract `char_ids (B,S,W)` where **S = label units, W = char composition window** — ONE contract for Latin char-word AND CJK char-level | **IRREVERSIBLE** (ONNX signature; neural/ + neural-web/ reimplement byte-for-byte) |
| D2  | Char vocab = sealed codepoint-sorted JSON, built from train split, shipped in weights pkg                                                       | **IRREVERSIBLE** per model (tokenizer-mismatch scar)                               |
| D3  | CJK unit = **one character** (not morpheme-grouped); per-char BIO                                                                               | **IRREVERSIBLE** (codifies TS decoder JP span reconstruction)                      |
| D4  | JP compact `2-3-16` = **one house_number span**; JP-seven fine tags reserved for kanji-designator forms only                                    | IRREVERSIBLE-ish (shard rebuild to change)                                         |
| D5  | Leg-1 probe trains on universal STAGE3 subset (region/locality/street/house_number/postcode), NOT JP-seven                                      | Reversible (probe-scoped)                                                          |
| D6  | Context window `ctx_chars=3` for CJK (W=7), `ctx_chars=0` for Latin char-word                                                                   | Config knob, ablatable                                                             |

## (a) Contract

Unifying observation: `CharCNNEmbedding.forward` consumes `char_ids (B,S,W)→(B,S,hidden)`, never asks what a "position" is. **S = label units** (things carrying one BIO label), **W = chars describing that unit**. Latin char-word: unit=whitespace token, W=token chars (ctx=0). CJK char-level: unit=one char, W=char ±3 neighbors (W=7). W=1 degenerates the multi-width CNN (kernels 3/4/5 see 1 char + pad); W=7 gives it local n-gram detection (丁目/番地/号 as units) at negligible cost. Window-composition replaces word-composition.

Probe shapes: `char_ids (B,S=96,W=7) int64` (slot j = char_to_id[raw[s−3+j]], off-unit/OOB=PAD 0, unseen=UNK 1); `attention_mask (B,S)`; `labels (B,S)` per-unit BIO, IGNORE −100 on pad. S=96 (char count, JP rows ~15–70 chars). No change to MailwomanCoarseEncoder.forward (use_char_embed branch already derives (bsz,seq) from char_ids.shape). Encoder pad-mask (183–190) already handles edge windows.

New `char_tokenizer.encode_row_units(raw, unit_spans, char_labels, char_to_id, max_units, max_unit_width, ctx_chars)`. Key reuse: **`tokenizer.char_label_array_from_spans` (tokenizer.py:153) already emits the per-char BIO the CJK path needs** — for CJK `unit_spans=[(i,i+1)...]`, per-unit labels ARE the per-char array (no projection). Latin: `unit_spans=whitespace_spans`, B/I re-flip per unit. `encode_row_charword` stays (frozen-probe reproducibility), becomes thin wrapper over `encode_row_units(ctx=0)`.

data_loader wiring: `DataConfig.char_mode: "off"|"word"|"char"` (default off) + `char_vocab_path`/`char_ctx`/`max_unit_width`; `EncodedExample.char_ids`; char branch at `iter_encoded` (549) skips SentencePiece, calls char_label_array_from_spans → encode_row_units; **requires span-schema shards** (raise on token-only); collate emits char_ids `(B,S,W)`. **Anchor/gazetteer/country channels OFF for probe** (per-unit re-alignment is post-probe). Char vocab (D2): `build_char_vocab` over JP train split min_count=2, ~3–5k entries, embed_dim 64 ≈ 0.3M params (vs SP 28M — confirms "char model is smaller"). Runtime char→id+unitization+windowing is a v8 SHIP item; **probe gate is evaluated entirely in Python**.

## (b) Unification: ONE code route, TWO trained artifacts for v8, defer single-model to v9

1. **Code path unified (D1)** — fork is entirely data-side segmentation (whitespace_spans vs per-char) feeding same encode_row_units/CharCNN/ONNX. No upside to two routes. v9-safe: plumbing never forks.
2. **v8 trained artifacts separate, script-routed** — Latin SP model untouched (provable-zero regression, byte-identical). Router = Unicode-block histogram in query-shape → CJK-dominant → char model, else SP.
3. **One char model for all scripts = open, Leg-2 answers cheaply** — train bare char model (ctx=0, char-word) on Latin corpus vs bare SP on Latin coord boards. Match within noise → v9 considers unification (1 artifact, no router, cross-script transfer), tradeoff = Latin dilution (#825 scar) + loss of provable-zero + multilingual balancing. v9 decision w/ measured receipt, never v8 default.

## (c) JP number (D4): whole-span house_number

Compact `2-3-16` → single house_number; split into block/sub_block/building_number ONLY for kanji-designator long form (2丁目3番16号) when it enters corpus (Phase 2+). Reasoning: compact form carries NO per-part surface evidence (part→role depends on count + preceding 丁目 = deterministic arithmetic, not per-token ambiguity — "no load-bearing trivia"; sub-part split is resolve-time arithmetic, 100% recoverable from span text + part count). Long form carries designators in surface (kanji IS evidence, per-char-taggable) → the declared fine tags. Two-surface rule. Probe: Overture-JP number field IS compact, Phase-0 aligner emits it as one span → runs on existing STAGE3 head, zero schema work, comparable to bare-Latin floor. Formatter match-key normalizes both to same chōme/banchi/go at resolve.

## (d) Leg-1 probe

Fresh MailwomanCoarseEncoder, Latin-substrate geometry (hidden 384, 4 layers, STAGE3 33-label), use_char_embed, JP char_vocab, ctx=3/W=7/S=96, NO anchor/gaz/country/phrase, no CRF, fresh position table. `v8-jp-probe.yaml`, standing Modal path (never shell-timeout). ~8k steps ~1 A100-hr. Corpus ~200k JP rows from on-disk Overture-JP 19.6M via locale-recipe, source=overture-jp, span-triple (#519), align.ts (Phase-0-verified), stratified 46 prefectures + urban-chōme fraction, native large-to-small, space-free, +〒postcode fraction. **Country-intl fraction is Phase-3 full-shard, not probe** (country not on probe board). Shard sanity: no all-O, raw BIO coverage (JSON-hides-gaps scar), per-prefecture counts. Held-out board 1.5–2k rows held by MUNICIPALITY bucket (unseen localities). Score: parse→resolve region+locality(+street/number) through JP admin gazetteer, coordinate-acceptability (coord-parity harness; WOF-JP point geometry at prefecture/county/ward, municipality centroids suffice).

**Gate (pre-registered): bare-char-JP coord acceptability ≥ 0.70 (bare-Latin floor).** PASS → Phase 2 (JP-seven activation, 33→47 head w/ own param-group LR per #727) + Phase 3 (full shard + channels re-aligned per-unit). Run Leg-2 same session.

FAIL ladder (diagnose, never proceed on hope): (1) per-tag split — street/hn strong, region/locality weak = unseen-kanji generalization gap → gazetteer channel moves up, NOT encoder verdict; (2) boundary audit — spans off ±1-2 chars → windowing/BI-decode → ctx ablation + per-char argmax dump; (3) collapse — loader/vocab bug, check raw BIO + char_ids of hand-decoded row. FAIL rules out ONLY "bare char-level CharCNN alone reaches Latin floor on JP" — NOT char+channels/more-data/wider-window, and CANNOT indict alignment (Phase-0 retired at 1560/1560).
