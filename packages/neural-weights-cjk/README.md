# @mailwoman/neural-weights-cjk

Mailwoman neural-classifier weights for CJK scripts: the char-path base model, Japanese and Chinese under one
49-label head (`stage3-cjk`). Data-only; `@mailwoman/neural` loads it at runtime.

**0.0.1 is a name reservation** and shipped the card and the vocabulary only. The manifest now lists `model.onnx`, which
`mwops release copy-weights` materializes from `release.config.json`'s `charWeights.cjk` at release time; the first
functional release ships with the next `mailwoman` minor once the `ja-jp` / `zh-cn` overlays exist.

## What this package ships

- `model.onnx` — the char graph: inputs `char_ids` int64 `(batch, sequence, 7)` and `attention_mask` int64
  `(batch, sequence)`, output `logits (batch, sequence, 49)`. No `input_ids`.
- `char-vocab.json` — the sealed character vocabulary (2,337 entries, `<pad>` 0, `<unk>` 1, code-point order). This
  is the model's whole tokenizer: one unit per Unicode code point, a ±3 character window per unit, 96 units per row.
- `model-card.json` — the `encoder: "char"` block (`char_vocab`, `max_units`, `max_unit_width`, `char_ctx`), the 49
  BIO labels, the training provenance, and the board reads.

## What this package does NOT ship

- **No `tokenizer.model`.** A char graph has no SentencePiece vocabulary; weights resolution requires
  `char-vocab.json` in its place (`packages/neural/lib/weights.ts`, the card's `encoder` block).
- **No soft-feed channels.** The char path is channel-free by contract: no postcode-anchor, gazetteer, country or
  evidence lexicons, and the graph declares no channel inputs.
- **No FST autocomplete artifact.** `fst-ja-jp.bin` / `fst-zh-cn.bin` have no builder yet (#1493).
- **No locale overlays yet.** `@mailwoman/neural-weights-ja-jp` and `-zh-cn` are data-only overlays over this base;
  the locale hint routes a `cjk` character class to `ja-JP`, which is where routing lands once the overlay exists.

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

`v8-cjk-kana` seed 42, 24,000 steps from scratch on the v8-jp-kana JP corpus (2,000,000 rows, Overture-JP, five
registers including the municipality's kana reading) plus 126 Chinese organizational-unit rows at a 2% source share.
On the 20,000-row held-out JP board the PyTorch read is 0.9924 coordinate-acceptability at 15 km (municipality macro
0.9821); the shared head it replaces, `v8-cjk-full`, read 0.9653 on the same board and failed 598 rows of one hiragana
municipality that this run fails 0 of (#2165). The remaining low municipality is a 町 with 市 inside its name (#2178).
Decision record: `docs/superpowers/specs/2026-09-05-cjk-serving-path.md`; the run record is
`docs/records/evals/2026-09-06-v8-cjk-shared-head.md`; receipts on #1176, #2034, #2164 and #2165.

## Dev setup

The graph is not committed. Link it into the data-root overlay from `release.config.json`'s `charWeights.cjk`:

```bash
node packages/neural-weights-cjk/scripts/link-dev-weights.ts
```

At release time `mwops release copy-weights` materializes the same two files into the workspace from that recipe.
