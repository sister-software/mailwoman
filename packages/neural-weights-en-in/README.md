# @mailwoman/neural-weights-en-in

Indian English (`en-IN`) weights overlay for [mailwoman](https://mailwoman.ai).

**Data-only.** Declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"` and shares that
package's model and tokenizer. What it adds is the Indian **placetype-pair index** — 175,744
`(area, city)` pairs from Who's On First — so `12 MG Road, Indiranagar, Bengaluru, Karnataka 560038`
resolves `Indiranagar` as a dependent locality with `Bengaluru` as the city, instead of fusing the
two.

It also ships the four evidence lexicons the base model was trained against — `anchor-lexicon-v1.json`,
`country-surface-lexicon-v1.json`, `street-type-lexicon-v3.json`, `locality-surface-lexicon-v7.json` — and
its `model-card.json` copies the base card's `requires` block, so a consumer runs the same channels the
board grades. A data-only overlay without them ran gazetteer, country and both evidence channels off
against a model trained with them (#2115).

## Two things specific to India

**Renames.** WOF stores `Bangalore`; addresses today say `Bengaluru`. The index stores English name
variants for parents in this locale so both resolve. The variants are enabled only for India, because
India is the locale where they were measured.

**Deprecated records.** 53% of WOF's Indian sub-locality nodes have `edtf:deprecated`, against
0–2.5% for every other shipped locale. Only live records are indexed.

## Install

```sh
npm install @mailwoman/neural-weights-en-in
```

## Attribution

This overlay decodes through the `@mailwoman/neural-weights-en-us` model graph, which trained on
address rows derived from OpenStreetMap. A consumer of this package alone receives rows that graph was
trained to read, so the notice applies here too:

> © OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0
> (https://opendatacommons.org/licenses/odbl/1-0/); see https://www.openstreetmap.org/copyright.

`LICENSE.md` in this package repeats the base graph's required attributions, and
https://mailwoman.ai/resources/osm/attribution explains how Mailwoman reads the license.
