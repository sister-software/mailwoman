# v8 Phase-0 — JP field→char-span alignment de-risk

**Date:** 2026-07-18 (night). **Verdict: PASS. The named biggest v8 risk is retired. The JP char-path Leg-1 probe is unblocked; the only remaining plumbing is the `char_ids` data-loader path.**

## The risk (Fable v8-CJK plan, §"biggest unnamed risk")

CJK addresses have no whitespace, and Overture gives field _values_ (`street`, `number`, `address_levels`) not character offsets. The plan flagged: field→character-span alignment over unsegmented kanji could be an ambiguous substring-match problem — potentially forcing a MeCab/Sudachi (morphological segmenter) or block-regex dependency **before** any v8 compute is worth spending. Phase-0 gate: **≥95% clean alignment** on a hand-checkable sample, or the segmenter dependency is named.

## The test

`scratchpad/jp-phase0/alignment-report.txt`. Overture-JP schema: `street` (kanji aza / chōme name, e.g. `字崎枝`, `神南1丁目`), `number` (Latin digits + hyphens, banchi-go, e.g. `556-16`, `2-3-16`), `address_levels[]` = [prefecture 都道府県, municipality 市区町村]. Concatenate large-to-small (JP reading order): `沖縄県石垣市字崎枝556-16`. Greedy left-to-right span alignment (find each field value from the cursor); a row is CLEAN iff every field is contiguous and the fields cover the whole string with no gap/overlap. Ambiguity metric: does any field value occur >1× in the concatenation (a naive matcher couldn't place it uniquely)?

- **Run 1** — 500 rows (region-clustered): **500/500 = 100% clean, 0 repeat-substring ambiguity.**
- **Run 2** — 1,060 rows strided across 159 row-groups spanning **all 46 prefectures**, incl. **171 rows with urban 丁目 (chōme) structure**: **1,060/1,060 = 100% clean.**

## Why it's clean (the structural reason)

Japanese address field values are mutually non-colliding: prefecture/municipality/street are distinct kanji sequences, and the number is Latin digits — so even a naive substring matcher places each uniquely (0 collisions across 1,560 rows). The urban chōme case (`…神南1丁目3-16`) aligns identically — the chōme lives inside the `street` value, the trailing `3-16` is the `number`. **No morphological segmenter is needed for the training-corpus alignment.** (This is corpus-build alignment, where we construct the string from the fields; a segmenter would only be needed if we had to align fields to a _pre-existing_ free-text JP string, which the corpus never does.)

## What this unblocks + the remaining plumbing

- **Leg-1 JP char probe is UNBLOCKED** — the char-encoder scaffolding exists (`corpus-python/src/mailwoman_train/model.py:CharCNNEmbedding` + `char_tokenizer.py`, both gated off, #825), the JP schema tags are declared (`SCHEMA.mdx`: prefecture/municipality/sub_block, Phase-6 forward-compat), and JP Overture data is on disk (19.6M rows, CDLA-Permissive-2.0).
- **Remaining work (the real gate, NOT alignment, and NOT purely mechanical) — a char-encoding DESIGN decision:** the existing char encoder `char_tokenizer.encode_row_charword` is **char-WORD** (chars grouped by whitespace `tokens`, one BIO label per word) — built for Latin (#825 Slavic diacritics). **JP has no whitespace and needs per-CHARACTER labels** (prefecture-chars and street-chars sit in the same unsegmented run and carry different tags). So the CharCNN scaffolding is half-built _for the Latin char-word case_; the JP char-path needs a **char-level** encoding (per-position ids + per-char BIO), plus the `data_loader.py` `char_ids` route. This is the true Leg-1 prerequisite and it's a design choice (char-level vs char-word grouping for a whitespace-less script), not a mechanical wire-up — it wants operator/Fable design sign-off before it's built, since it defines the v8 char model's input contract. **Recommend: this is a day-shift collaborative arc, not a pre-handoff rush.**

## Corpus-build de-risk — also PASS (bonus, #555 does not bite kanji)

Beyond the alignment concept, the actual corpus aligner `corpus/src/align.ts::alignRow` was tested on JP kanji canonical rows and produces **correct char-offset span labels**:

- `沖縄県石垣市字崎枝556-16` → `region[0:3] locality[3:6] street[6:9] house_number[9:15]`
- `東京都渋谷区神南1丁目3-16` (urban Tokyo, chōme) → `region[0:3] locality[3:6] street[6:11]`(=`神南1丁目`)` house_number[11:15]`(=`3-16`)

**#555** (`locateSpan over-runs raw on non-Latin combining-mark strings`) does **not** apply to kanji — kanji are single code points with no combining marks, so the span offsets are exact. **The JP corpus is buildable now** as `(raw, char-offset span_tags)` rows — encoder-agnostic; the char-level-vs-char-word decision is a _training-time_ read of these spans, not a corpus-build blocker. (Combining-diacritic scripts — some Indic, heavily-accented Latin — would still need the #555 fix; kanji/hangul/hanzi core CJK do not.)

**Net v8 data-pipeline status: fully green.** Both the alignment concept and the corpus-build infra handle JP cleanly. The only remaining v8 work is training-side: the char-level encoder/loader/model rework (above) — a scoped day-shift arc, not a data problem.

## One schema decision to make (not a blocker)

The JP `number` is frequently **multi-part** (`2-3-16` = 2丁目3番16号 = chōme-banchi-go). Decide: map the whole `2-3-16` to `house_number`, or split into the declared `sub_block` (banchi) + a go component. This is a schema/label choice for the JP model's vocab — decide it when building the JP shard, not before.

## Recommendation

KR-first is **not executable** (no Overture-KR data — the pull returns empty; needs a juso.go.kr / OSM-KR acquisition arc). So **JP-first is both the headline choice and the only executable non-Latin path** — which resolves the v8 plan's §4 KR-vs-JP reframe with a receipt. Next v8 step: wire the `char_ids` loader path → run Leg-1 (bare JP char model on ~200k rows vs a held-out JP coord board, gate ≥ bare-Latin floor ~0.70). Leg-2 (Latin char bake-off, no JP dependency) exercises the same loader and answers the v9-unification question.
