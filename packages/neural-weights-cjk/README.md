# @mailwoman/neural-weights-cjk

Mailwoman neural-classifier weights for CJK scripts: the char-path base model, Japanese and Chinese under one
49-label head (`stage3-cjk`). Data-only; `@mailwoman/neural` loads it at runtime.

**0.0.1 is a name reservation** and ships the card and the vocabulary only; `model.onnx` joins the manifest's `files`
with the first functional release, which ships with the next `mailwoman` minor once the served board read is recorded
on the epic (#2164) and the `ja-jp` / `zh-cn` overlays exist. The tarball audit refuses a manifest that promises a file
the tarball lacks, so the graph is not listed until it is materialized at release time.

## What this package ships

- `model.onnx` — the char graph: inputs `char_ids` int64 `(batch, sequence, 7)` and `attention_mask` int64
  `(batch, sequence)`, output `logits (batch, sequence, 49)`. No `input_ids`.
- `char-vocab.json` — the sealed character vocabulary (2,335 entries, `<pad>` 0, `<unk>` 1, code-point order). This
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

`v8-cjk-full` seed 42, 24,000 steps from scratch on the v8-jp-full JP corpus (2,000,000 rows, Overture-JP) plus 126
Chinese organizational-unit rows at a 2% source share. On the 20,000-row held-out JP board the PyTorch read is 0.9653
coordinate-acceptability at 15 km and the served TypeScript read 0.9633, every tag within 0.2 pp of the other; 598 of
the 664 failed rows are one held-out hiragana municipality, which the JP-only control also fails (#2165). Decision
record: `docs/superpowers/specs/2026-09-05-cjk-serving-path.md`; receipts on #1176, #2034 and #2164.

## Dev setup

The graph is not committed. Copy it from the data root's artifact of record:

```bash
cp $MAILWOMAN_DATA_ROOT/models/v8-cjk-full-s42/served-package/model.onnx packages/neural-weights-cjk/
```

A `link-dev-weights` script over `materializeDevOverlay` follows with the first functional release.
