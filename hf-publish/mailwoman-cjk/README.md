---
license: agpl-3.0
language:
  - ja
  - zh
library_name: onnxruntime
pipeline_tag: token-classification
tags:
  - address-parsing
  - ner
  - token-classification
  - sequence-tagging
  - onnx
  - mailwoman
  - japanese
  - chinese
datasets:
  - overture-maps
  - whosonfirst
metrics:
  - accuracy
base_model: mailwoman-cjk
---

# Mailwoman — Neural Address Parser (CJK: Japanese + Chinese)

The character-path member of the mailwoman family: one graph, one sealed character vocabulary, one 49-label head for
Japanese and Chinese addresses. It ships as `@mailwoman/neural-weights-cjk` on npm and runs under `@mailwoman/neural`
on Node and in the browser (ONNX Runtime Web).

- **Source**: https://github.com/sister-software/mailwoman
- **Docs**: https://mailwoman.ai/docs
- **License**: AGPL-3.0 (a commercial license is available: https://mailwoman.ai/license)

## Usage

```js
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "ja-JP" })
await classifier.parseJSON("東京都千代田区丸の内1丁目9-1")
// { prefecture: "東京都", municipality: "千代田区", district: "丸の内", block: "1丁目", house_number: "9-1" }
```

There is no SentencePiece tokenizer: the encoder is one unit per Unicode code point with a ±3 character window over
`char-vocab.json`. The graph's inputs are `char_ids` (int64, batch × sequence × 7) and `attention_mask` (int64,
batch × sequence); the output is `logits` (batch × sequence × 49).

## Model details

| Field         | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Architecture  | Transformer encoder (h384, 4L, 6H), 64-d character embedding |
| Parameters    | 7.6M                                                         |
| Vocabulary    | 2,337 characters (`<pad>` 0, `<unk>` 1, code-point order)    |
| Max units     | 96                                                           |
| Output labels | 49 (1 `O` + 24 BIO tags × 2), label set `stage3-cjk`         |
| Precision     | fp32 (30.6 MB)                                               |
| ONNX opset    | 17                                                           |

The label set is the Latin `stage3` set plus the Japanese tiers (`prefecture`, `municipality`, `district`, `block`,
`sub_block`, `building_number`, `building_name`) and the Chinese organizational ladder (`locality_unit`).

## Training and evaluation

Trained from scratch (`v8-cjk-kana`, seed 42, 24,000 steps, batch 256, bf16, cosine) on 2,000,000 Japanese rows
rendered from Overture Maps addresses in five registers (the postal form, Arabic chōme, the compact folded number,
the designator form, and the municipality's kana reading), plus 126 Chinese organizational-unit rows at a 2% share.

| Read                                                                                       |                         Value |
| ------------------------------------------------------------------------------------------ | ----------------------------: |
| Japanese board, 20,000 rows, 51 held-out municipalities: coordinate-acceptability at 15 km |                        0.9924 |
| Municipality macro over the held-out municipalities                                        |                        0.9821 |
| Per-tag span exact-match: prefecture / municipality / district / house_number              | 1.000 / 0.994 / 0.987 / 0.993 |
| Chinese board, 14 rows: `locality_unit` span exact-match                                   |                         11/14 |

The Chinese side is a supply-limited overlay (126 labeled rows in total); the number is reported, not claimed. The
receipts are in the repository under `docs/records/evals/`.

## Files

| File              | Purpose                                     |
| ----------------- | ------------------------------------------- |
| `model.onnx`      | the classifier graph behind `char_ids`      |
| `char-vocab.json` | the sealed character vocabulary             |
| `model-card.json` | the machine-readable card the runtime reads |

## Attribution

Japanese address data © Overture Maps Foundation contributors (CDLA-Permissive-2.0); administrative names from
Who's On First. The model weights are AGPL-3.0-only OR LicenseRef-Commercial.
