---
license: AGPL-3.0
language:
  - en
library_name: onnxruntime
pipeline_tag: token-classification
tags:
  - address-parsing
  - ner
  - token-classification
  - sequence-tagging
  - onnx
  - mailwoman
datasets:
  - openaddresses
  - whosonfirst
  - tiger-line
metrics:
  - f1
  - accuracy
base_model: mailwoman-en-us
---

# Mailwoman — Neural Address Parser (en-US, v0.5.4)

Mailwoman is an open-source neural address parser that runs entirely in the browser via ONNX Runtime Web.

- **Source**: https://github.com/sister-software/mailwoman
- **Demo**: https://mailwoman.ai/demo
- **Docs**: https://mailwoman.ai/docs
- **License**: AGPL-3.0

## Usage

```js
import * as ort from "onnxruntime-web/webgpu"

// Load the model
const session = await ort.InferenceSession.create(
	"https://huggingface.co/sister-software/mailwoman-en-us/resolve/main/model.onnx"
)

// Tokenize with the bundled SentencePiece tokenizer (see @mailwoman/neural for the wrapper)
// Run inference → 21 BIO labels per token
```

For a high-level API see the [`mailwoman` npm package](https://www.npmjs.com/package/mailwoman).

## Model details

| Field               | Value                                         |
| ------------------- | --------------------------------------------- |
| Architecture        | Transformer encoder (h384, 6L, 6H)            |
| Parameters          | 38M (29M encoder + 9M embedding)              |
| Vocabulary          | 48,000 (SentencePiece unigram, byte-fallback) |
| Max sequence length | 128                                           |
| Output labels       | 21 (1 `O` + 10 BIO tags × 2)                  |
| Quantization        | int8 dynamic (28 MB)                          |
| FP32 size           | 117 MB                                        |
| ONNX opset          | 17                                            |

## Labels (Stage 2)

The model emits BIO-encoded labels for 10 address components:

- `country`, `region`, `locality`, `dependent_locality`, `postcode`, `subregion`, `cedex`
- `venue`, `street`, `house_number`

Stage 3 (street decomposition + unit + po_box + intersection) is planned for v0.6.0.

## Training

| Field             | Value                                               |
| ----------------- | --------------------------------------------------- |
| Corpus version    | 0.4.0                                               |
| Tokenizer version | 0.6.0-a0 (multi-script, 0% CJK byte-fallback)       |
| Steps             | 100,000                                             |
| Hardware          | NVIDIA A100-SXM4-40GB                               |
| Recipe            | v0.5.1 (constant LR, smoothing off, wof-admin: 2.0) |

Training data sources:

- **OpenAddresses** (CC-BY / public domain subsets) — global street-level addresses
- **Who's On First** (CC-BY-4.0 + ODbL-1.0) — admin hierarchy for US, FR, JP, CN, KR, DE, GB
- **TIGER/Line** (public domain) — US street segments
- **BAN** (ODbL-1.0) — French street-level addresses

## Evaluation

| Test                                    | Result      |
| --------------------------------------- | ----------- |
| Demo presets (6 canonical addresses)    | 6/6 correct |
| Golden eval exact match (4,535 entries) | 17.0%       |

Exact-match metrics cannot be compared across tokenizer versions. The v0.5.3 baseline (25.3%) used a different tokenizer. Most of the failures are schema mismatches, because the golden set expects Stage 3 tags that this model does not emit.

## Limitations

- **English only**: the model was trained primarily on US addresses. French and other locales are planned.
- **Non-Latin scripts**: the tokenizer handles CJK/Korean/Thai (0% byte-fallback), but the training data is mostly Latin. CJK address parsing has not been validated.
- **Stage 2 schema**: the model does not decompose streets into prefix/suffix or emit unit/po_box/intersection. Stage 3 (v0.6.0) will add these.

## Citation

```
@software{mailwoman2026,
  title = {Mailwoman: Neural Address Parser},
  author = {Ellis, Teffen and contributors},
  year = {2026},
  url = {https://github.com/sister-software/mailwoman},
  license = {AGPL-3.0}
}
```
