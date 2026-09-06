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
| Vocabulary    | 3,165 characters (`<pad>` 0, `<unk>` 1, code-point order)    |
| Max units     | 96                                                           |
| Output labels | 49 (1 `O` + 24 BIO tags × 2), label set `stage3-cjk`         |
| Precision     | fp32 (30.8 MB)                                               |
| ONNX opset    | 18                                                           |

The label set is the Latin `stage3` set plus the Japanese tiers (`prefecture`, `municipality`, `district`, `block`,
`sub_block`, `building_number`, `building_name`) and the Chinese organizational ladder (`locality_unit`).

## Training and evaluation

Trained from scratch (`v8-cjk-kr`, seed 42, 24,000 steps, batch 256, bf16, cosine) on 2,000,000 Japanese rows
rendered from Overture Maps addresses in five registers (the postal form, Arabic chōme, the compact folded number,
the designator form, and the municipality's kana reading), 2,000,000 Korean road-name-address rows from the
national register in five registers (official, without the 동, postcode-first, short region, unspaced) at a 38%
share, plus 126 Chinese organizational-unit rows at a 2% share. Korean adds no tag: 시/도 is `region`, 시군구 is
`subregion`, 읍면동 is `dependent_locality`, the road name is `street`, the building number `house_number`.

| Read                                                                                            |                         Value |
| ----------------------------------------------------------------------------------------------- | ----------------------------: |
| Japanese board, 20,000 rows, 82 held-out municipalities: native-register acceptability at 15 km |                        0.9921 |
| Per-tag span exact-match: prefecture / municipality / district / house_number                   | 1.000 / 0.994 / 0.986 / 0.992 |
| Korean board, 20,000 rows, 27 held-out 시군구: region / subregion / dependent_locality exact    |         1.000 / 0.967 / 0.998 |
| Korean board: street / house_number / postcode exact                                            |         0.990 / 1.000 / 1.000 |
| Chinese board, 14 rows: `locality_unit` span exact-match                                        |                         12/14 |

The Korean `subregion` number is one held-out city: 669 of its 671 misses are `해운대구`, which the model closes early
as `해` or `해운대`; the other 26 held-out cities read 19,317 of 19,319. The Chinese side is a supply-limited overlay
(126 labeled rows in total); the number is reported, not claimed. The receipts are in the repository under
`docs/records/evals/`.

## Files

| File              | Purpose                                     |
| ----------------- | ------------------------------------------- |
| `model.onnx`      | the classifier graph behind `char_ids`      |
| `char-vocab.json` | the sealed character vocabulary             |
| `model-card.json` | the machine-readable card the runtime reads |

## Attribution

Japanese address data © Overture Maps Foundation contributors (CDLA-Permissive-2.0); administrative names from
Who's On First. Korean road-name address data from 행정안전부 (Ministry of the Interior and Safety), 도로명주소
(juso.go.kr), under 공공누리 제1유형 (KOGL Type 1): attribution required; commercial use, derivatives and
redistribution permitted. The model weights are AGPL-3.0-only OR LicenseRef-Commercial.
