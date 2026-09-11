# @mailwoman/neural-weights-cjk

Mailwoman neural-classifier weights for CJK scripts: the char-path base model, Japanese, Korean, Taiwanese and
Chinese under one 49-label head (`stage3-cjk`). Data-only; `@mailwoman/neural` loads it at runtime.

The manifest lists `model.onnx`, which `mwops release copy-weights` materializes from `release.config.json`'s
`charWeights.cjk` at release time; the `ja-jp` / `zh-cn` overlays are data-only packages over this base.

## What this package ships

- `model.onnx` — the char graph: inputs `char_ids` int64 `(batch, sequence, 7)` and `attention_mask` int64
  `(batch, sequence)`, output `logits (batch, sequence, 49)`. No `input_ids`.
- `char-vocab.json` — the sealed character vocabulary (4,451 entries, `<pad>` 0, `<unk>` 1, code-point order). This
  is the model's whole tokenizer: one unit per Unicode code point, a ±3 character window per unit, 96 units per row.
- `model-card.json` — the `encoder: "char"` block (`char_vocab`, `max_units`, `max_unit_width`, `char_ctx`), the 49
  BIO labels, the training provenance, and the board reads.

## What this package does NOT ship

- **No `tokenizer.model`.** A char graph has no SentencePiece vocabulary; weights resolution requires
  `char-vocab.json` in its place (`packages/neural/lib/weights/index.ts`, the card's `encoder` block).
- **No soft-feed channels.** The char path is channel-free by contract: no postcode-anchor, gazetteer, country or
  evidence lexicons, and the graph declares no channel inputs.
- **No FST autocomplete artifact.** `fst-ja-jp.bin` / `fst-zh-cn.bin` ship in the `@mailwoman/neural-weights-ja-jp` and
  `-zh-cn` overlays, data-only packages over this base.

## Loading it today

```ts
import { NeuralAddressClassifier } from "@mailwoman/neural/classifier"

const classifier = await NeuralAddressClassifier.loadFromWeights({
	modelPath: "<package>/model.onnx",
	charVocabPath: "<package>/char-vocab.json",
	modelCardPath: "<package>/model-card.json",
})

await classifier.parseJSON("東京都千代田区丸の内1丁目9-1")
// { prefecture: "東京都", municipality: "千代田区", district: "丸の内", block: "1丁目", house_number: "9-1" }
```

## Provenance

`v8-cjk-regs` seed 42, 8,000 steps from scratch on the v8-jp-kana JP corpus (2,000,000 rows, Overture-JP, five
registers including the municipality's kana reading), the Korean road-name address register rebuilt from the
ministry's 2026-08 주소DB (2,000,000 rows, seven registers including the lot-number form), the Taiwan corpus from
Overture-TW (2,000,000 rows, five registers), three registries of typed business addresses aligned exactly against
those keys before training (Korean permits, Taiwanese companies, Japanese corporate numbers; 1,666,000 rows), and 126
Chinese organizational-unit rows. On the 20,000-row held-out JP board the native register reads 0.9954 acceptability at
15 km against the previous base's 0.9921 on the same scorer, and かすみがうら市 fails 0 of 823 rows. On the 20,000-row
Korean board over 26 held-out 시군구 the spans read region 1.000 / subregion 0.998 / dependent_locality 0.998 / street
0.999 / house_number 1.000 / postcode 1.000; on the 20,000-row Taiwan board over 28 held-out 鄉鎮市區, region 1.000 /
subregion 1.000 / street 0.999 / house_number 0.999. The 町 whose names carry 市 are closed at decode time by the
register in `@mailwoman/codex/jp` (#2178).
Decision record: `docs/superpowers/specs/2026-09-05-cjk-serving-path.md`; the run record is
`docs/records/evals/2026-09-08-v8-cjk-regs.md`; receipts on #1176, #2034, #2164, #2184 and #2204.

## Dev setup

The graph is not committed. Link it into the data-root overlay from `release.config.json`'s `charWeights.cjk`:

```bash
node packages/neural-weights-cjk/scripts/link-dev-weights.ts
```

At release time `mwops release copy-weights` materializes the same two files into the workspace from that recipe.
