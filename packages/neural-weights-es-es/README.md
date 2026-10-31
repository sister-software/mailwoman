# @mailwoman/neural-weights-es-es

es-ES weights overlay for [mailwoman](https://mailwoman.ai).

**Data-only.** Declares `mailwoman.baseWeights` and shares the base model and tokenizer with
`@mailwoman/neural-weights-en-us`; what it adds is `pair-index-es.bin`.

It also ships the four evidence lexicons the base model was trained against — `anchor-lexicon-v1.json`,
`country-surface-lexicon-v1.json`, `street-type-lexicon-v3.json`, `locality-surface-lexicon-v7.json` — and
its `model-card.json` copies the base card's `requires` block, so a consumer runs the same channels the
board grades. A data-only overlay without them ran gazetteer, country and both evidence channels off
against a model trained with them (#2115).

```sh
npm install @mailwoman/neural-weights-es-es
```

## Attribution

This overlay decodes through the `@mailwoman/neural-weights-en-us` model graph. That graph trained on
address rows derived from OpenStreetMap. A consumer who installs only this package receives rows that graph was
trained to read, so the notice applies here too:

> © OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0
> (https://opendatacommons.org/licenses/odbl/1-0/); see https://www.openstreetmap.org/copyright.

`LICENSE.md` in this package repeats the base graph's required attributions, and
https://mailwoman.ai/resources/osm/attribution explains how Mailwoman reads the license.
