# @mailwoman/neural-weights-en-in

Indian English (`en-IN`) weights overlay for [mailwoman](https://mailwoman.ai).

**Data-only.** Declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"` and shares that
package's model and tokenizer. What it adds is the Indian **placetype-pair index** — 175,744
`(area, city)` pairs from Who's On First — so `12 MG Road, Indiranagar, Bengaluru, Karnataka 560038`
resolves `Indiranagar` as a dependent locality with `Bengaluru` as the city, instead of fusing the
two.

It also ships the four evidence lexicons the base model was trained against — `anchor-lexicon-v1.json`,
`country-surface-lexicon-v1.json`, `street-type-lexicon-v3.json`, `locality-surface-lexicon-v7.json` — and
its `model-card.json` carries the base card's `requires` block, so a consumer runs the same channels the
board grades. A data-only overlay without them ran gazetteer, country and both evidence channels OFF
against a model trained with them (#2115).

## Two things specific to India

**Renames.** WOF stores `Bangalore`; addresses today say `Bengaluru`. The index carries English name
variants for parents in this locale so both resolve — enabled for India alone, because that is where
it was measured.

**Deprecated records.** 53% of WOF's Indian sub-locality nodes carry `edtf:deprecated`, against
0–2.5% for every other shipped locale. Only live records are indexed.

## Install

```sh
npm install @mailwoman/neural-weights-en-in
```
