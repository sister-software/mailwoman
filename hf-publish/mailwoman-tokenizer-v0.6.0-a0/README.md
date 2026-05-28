---
license: agpl-3.0
language:
- en
- fr
- de
- ja
- ko
- zh
- ar
- ru
- th
library_name: sentencepiece
tags:
- tokenizer
- sentencepiece
- multi-script
- address-parsing
- mailwoman
---

# Mailwoman SentencePiece Tokenizer v0.6.0-a0

Multi-script SentencePiece tokenizer trained for address parsing. Achieves **0% byte-fallback** on CJK, Korean, Thai, and Arabic scripts (down from 36–75% on prior tokenizers).

- **Source**: https://github.com/sister-software/mailwoman
- **License**: AGPL-3.0

## Training data

2.19 million place-name records from Who's On First across 7 countries:

| Script group | Lines |
|--------------|-------|
| Latin (en/fr/de/es/it/pt/nl/sv/pl) | 500,000 |
| Chinese (zho) | 500,000 |
| Cyrillic (rus/ukr/bul/srp) | 468,111 |
| Arabic (ara/fas/urd) | 285,109 |
| Japanese (jpn) | 183,219 |
| Korean (kor) | 94,414 |
| Other (tha/hin/ben/heb/ell) | 160,407 |

## Format

| Field | Value |
|-------|-------|
| Algorithm | SentencePiece unigram |
| Vocabulary size | 48,000 |
| Character coverage | 0.9999 |
| Byte-fallback | enabled |
| Split digits | false |
| User-defined symbols | 64 (US state abbreviations + postcode formats) |
| Model size | 1.0 MB |

## Byte-fallback rates

Measured on 12 hard multi-script address examples:

| Script | Old (v0.5.0-a1) | This tokenizer (v0.6.0-a0) |
|--------|----------------|---------------------------|
| Chinese | 50–75% | **0%** |
| Japanese | 58–60% | **0%** |
| Korean | 41% | **0%** |
| Thai | 30% | **0%** |
| Arabic | 0% | 0% |
| Latin | 0% | 0% |
| **Aggregate** | **36.6%** | **0.0%** |

## Usage

```python
import sentencepiece as spm
tokenizer = spm.SentencePieceProcessor()
tokenizer.load("tokenizer.model")

pieces = tokenizer.encode_as_pieces("東京都新宿区西新宿2-8-1")
# ['▁', '東京', '都', '新宿', '区', '西', '新宿', '2', '-', '8', '-', '1']
```

## Files

| File | Description |
|------|-------------|
| `tokenizer.model` | SentencePiece binary (load with `spm.SentencePieceProcessor.load`) |
| `tokenizer.vocab` | Plain-text vocabulary listing (one piece per line, with score) |
| `model_card.json` | Training provenance metadata (SHA256, training lines, etc.) |
