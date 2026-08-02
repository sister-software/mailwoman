# @mailwoman/neural-weights-en-in

Indian English (`en-IN`) weights overlay for [mailwoman](https://mailwoman.sister.software).

**Data-only.** Declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"` and shares that
package's model and tokenizer. What it adds is the Indian **placetype-pair index** — 175,744
`(area, city)` pairs from Who's On First — so `12 MG Road, Indiranagar, Bengaluru, Karnataka 560038`
resolves `Indiranagar` as a dependent locality with `Bengaluru` as the city, instead of fusing the
two.

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
