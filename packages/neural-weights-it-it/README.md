# @mailwoman/neural-weights-it-it

it-IT weights overlay for [mailwoman](https://mailwoman.ai).

**Data-only.** Declares `mailwoman.baseWeights` and shares the base model and tokenizer with
`@mailwoman/neural-weights-en-us`; what it adds is `pair-index-it.bin`.

It also ships the four evidence lexicons the base model was trained against — `anchor-lexicon-v1.json`,
`country-surface-lexicon-v1.json`, `street-type-lexicon-v3.json`, `locality-surface-lexicon-v7.json` — and
its `model-card.json` carries the base card's `requires` block, so a consumer runs the same channels the
board grades. A data-only overlay without them ran gazetteer, country and both evidence channels OFF
against a model trained with them (#2115).

```sh
npm install @mailwoman/neural-weights-it-it
```
