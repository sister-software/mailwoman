---
license: agpl-3.0
language:
  - ja
  - ko
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
  - korean
  - chinese
datasets:
  - overture-maps
  - whosonfirst
metrics:
  - accuracy
base_model: mailwoman-cjk
---

# Mailwoman — Neural Address Parser (CJK: Japanese + Korean + Chinese)

The character-path member of the mailwoman family: one graph, one sealed character vocabulary, one 49-label head for
Japanese, Korean, Taiwanese and Chinese addresses. It ships as `@mailwoman/neural-weights-cjk` on npm and runs under `@mailwoman/neural`
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
| Vocabulary    | 4,451 characters (`<pad>` 0, `<unk>` 1, code-point order)    |
| Max units     | 96                                                           |
| Output labels | 49 (1 `O` + 24 BIO tags × 2), label set `stage3-cjk`         |
| Precision     | fp32 (31.2 MB)                                               |
| ONNX opset    | 18                                                           |

The label set is the Latin `stage3` set plus the Japanese tiers (`prefecture`, `municipality`, `district`, `block`,
`sub_block`, `building_number`, `building_name`) and the Chinese organizational ladder (`locality_unit`).

## Training and evaluation

Trained from scratch (`v8-cjk-regs`, seed 42, 8,000 steps, batch 256, bf16, cosine) on 2,000,000 Japanese rows
rendered from Overture Maps addresses in five registers (the postal form, Arabic chōme, the compact folded number,
the designator form, and the municipality's kana reading); 2,000,000 Korean rows from the national road-name address
register (주소DB) in seven registers (official, with the building name, without the 동, postcode-first, short region,
unspaced, and the lot-number form); 2,000,000 Taiwanese rows from Overture Maps addresses in five registers
(official, without the 村里, spaced, without the 縣市, with a floor unit); 1,666,000 typed business addresses from
three government registries (Korean permits, Taiwanese companies, Japanese corporate numbers), each aligned exactly
against the register above before it trained; plus 126 Chinese organizational-unit rows. Korean and Taiwanese add no
tag: 시/도 and 縣市 are `region`, 시군구 and 鄉鎮市區 are `subregion`, 읍면동/리 and 村里 are `dependent_locality`, the
road or street name is `street`, the building or house number `house_number`, a floor or sub-number `unit`.

| Read                                                                                            |                         Value |
| ----------------------------------------------------------------------------------------------- | ----------------------------: |
| Japanese board, 20,000 rows, 82 held-out municipalities: native-register acceptability at 15 km |                        0.9954 |
| Per-tag span exact-match: prefecture / municipality / district / house_number                   | 1.000 / 0.997 / 0.989 / 0.990 |
| Korean board, 20,000 rows, 26 held-out 시군구: region / subregion / dependent_locality exact    |         1.000 / 0.998 / 0.998 |
| Korean board: street / house_number / postcode exact                                            |         0.999 / 1.000 / 1.000 |
| Taiwanese board, 20,000 rows, 28 held-out 鄉鎮市區: region / subregion / street / house_number  | 1.000 / 1.000 / 0.999 / 0.999 |
| Japanese corporate-register board, 3,193 typed rows: district / building_name / house_number    |         0.983 / 0.988 / 0.984 |
| Korean permit-register board, 3,522 typed rows: dependent_locality / house_number / venue       |         0.999 / 0.999 / 0.731 |
| Chinese board, 14 rows: `locality_unit` span exact-match                                        |                         13/14 |

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
Who's On First. Japanese corporate-number register from 国税庁 法人番号公表サイト (National Tax Agency, Corporate Number
Publication Site); the three published fields are free for anyone to use under the site's 利用規約.

Korean road-name address data (주소DB) from 행정안전부 (Ministry of the Interior and Safety), 도로명주소 (juso.go.kr),
under 공공누리 제1유형 (KOGL Type 1): attribution required; commercial use, derivatives and redistribution permitted.
Korean permit registry from 행정안전부, 지방행정인허가데이터 (localdata.go.kr), 이용허락범위 제한 없음.

Taiwanese address data © Overture Maps Foundation contributors (CDLA-Permissive-2.0), from OpenAddresses under the
政府資料開放授權條款－第1版 (Open Government Data License, Taiwan, v1.0), which requires this attribution: New Taipei
City Government Civil Affairs Bureau; Taichung City Government Civil Affairs Bureau; Kaohsiung City Government Civil
Affairs Bureau; Taipei City Government Civil Affairs Bureau; Taoyuan City Government Civil Affairs Bureau; Tainan
City Government Civil Affairs Bureau; Changhua County Government Civil Affairs Office; Pingtung County Government;
Yunlin County Government; Hsinchu County Civil Affairs Office; Miaoli Civil Affairs Office; Hsinchu City Civil
Affairs Office; Keelung City Government Civil Affairs Bureau; Penghu County Government; Kinmen County Civil Affairs
Office (Overture release 2026-06-17.0). Taiwanese company register from 經濟部商業發展署 (Ministry of Economic
Affairs, Administration for Commerce Development) under the same license.

The model weights are AGPL-3.0-only OR LicenseRef-Commercial.
