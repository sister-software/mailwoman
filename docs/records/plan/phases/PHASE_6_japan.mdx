# Phase 6 — Japan Expansion (Architecture Validation)

**Goal:** add Japanese address support. This is the validation milestone for the architecture: if the schema, classifier interface, and policy system survive JP without core refactor, the design is sound.

**Status:** deferred. Begin only after Phase 3 has shipped, Stages 2 and 3 of training have completed for US/FR, and the human has confirmed.

**This document is a sketch.** Detailed plan written when Phase 6 begins.

## Why JP specifically

- **Structurally different addressing.** JP has no streets. Addresses are nested blocks (chōme/banchi/go). If any core code assumes "street is mandatory," it breaks here.
- **Different script.** CJK characters expose tokenizer vocabulary limits. SentencePiece with `byte_fallback=true` (set in Phase 1) should handle this, but real test only happens with real JP data.
- **Excellent open data.** MLIT (国土交通省) publishes comprehensive address data freely. Quality comparable to BAN.
- **Existing reference implementation.** `japanese-address-parser` Rust crate is a baseline to compare against.

## What must already work before Phase 6

- Schema has JP-specific tags reserved (it does — see `reference/SCHEMA.md`)
- `LocaleProfile.componentsSupported` is honored everywhere (it must be by Phase 0)
- No hardcoded assumption that `street` or `house_number` is required anywhere
- Tokenizer was trained with sufficient character coverage to handle CJK (set in Phase 1)

If any of these aren't true, the design failed and the project needs a Phase 0 revisit.

## Sketch tasks

### Data

- Adapter for MLIT address data (CSV format, comprehensive coverage of JP)
- Adapter for WOF JP admin records (already accessible)
- Synthesis rules for JP variants: kanji vs hiragana vs romaji, traditional vs modern numbering

### Tokenizer

- Validate existing tokenizer's CJK handling. May need to retrain with more JP samples in the SentencePiece training mix.
- If retraining, that's a corpus version bump. Don't ship a tokenizer change in a patch release.

### Model

- Continue training from US/FR checkpoint with JP data added
- Or train a separate JP-only model — depends on whether shared vocab benefits transfer or hurts via interference
- Decision point: measure both, pick winner

### Schema

- Add JP-specific `LocaleProfile` with `componentsSupported` including JP tags, excluding `street` and `house_number`
- Register JP rule classifiers (minimal — most work is the model)

### Validation

- Compare against `japanese-address-parser` on held-out JP addresses
- If we underperform a single-country specialist, that's expected and acceptable in v1
- If we underperform by > 10 F1 points, investigate — likely a vocab or alignment issue

## Open questions for when Phase 6 begins

- Single multilingual model vs per-locale models?
- Romaji-only support, kanji-only, or both?
- How aggressively to normalize variants (full-width vs half-width digits, traditional vs simplified kanji where applicable)
- Whether to include Korean/Chinese as bonus locales since vocab will be CJK-friendly by then

## What success looks like

When you can run:

```
npx mailwoman parse --locale ja-JP "東京都千代田区丸の内1-1-1"
```

and get a parse with `prefecture: 東京都, municipality: 千代田区, district: 丸の内, block: 1, sub_block: 1, building_number: 1` — and no core code changed since Phase 3, only adapters, weights, and locale profiles — the architecture is validated.

If core code did need to change, the change is the deliverable, not the JP support. Document what changed and why so future locales (Korean, Thai, etc.) benefit.
