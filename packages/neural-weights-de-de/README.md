# @mailwoman/neural-weights-de-de

German (`de-DE`) weights overlay for [mailwoman](https://mailwoman.sister.software).

**Data-only.** This package ships no model of its own — it declares
`mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"` and shares that package's `model.onnx`
and `tokenizer.model`. What it adds is the German **placetype-pair index**: 85,605
`(Ortsteil, Gemeinde)` pairs from Who's On First, applied as a soft decode-time prior so
`Neusser Str. 12, Nippes, 50733 Köln` resolves `Nippes` as a dependent locality instead of losing it.

## Why an overlay exists at all

The pair index is hard-gated on the resolved locale's country, so a German artifact shipped inside
another locale's package could never fire. A carrier package is the only way the prior reaches
German input — which is what blocked this locale until now, rather than any shortage of data.

## Install

```sh
npm install @mailwoman/neural-weights-de-de
```

Then resolve weights for `de-DE`; `@mailwoman/neural` picks up the sibling index automatically.
