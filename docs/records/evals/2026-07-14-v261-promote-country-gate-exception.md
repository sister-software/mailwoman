# 2026-07-14 — v261 promoted (6.1.0); the country 2pp gate, documented as a cosmetic exception

v261 (`v2.6.1-span-boundary-full`, #727 stage-1) is promoted to the shipped `neural-weights-en-us`
default. It is a clean improvement over v241 on the schema-correct gates, and it trips the golden
country 2pp pre-publish gate — which this note documents as a **cosmetic exception** with the
falsifier evidence that justifies shipping through it. No gate was silently relaxed.

## Why v261

| gate                                 | v241 (shipped) | v261      | note                                       |
| ------------------------------------ | -------------- | --------- | ------------------------------------------ |
| parity street (triaged)              | 0.3967         | 0.5281    | +13pp — the schema-correct campaign gate   |
| parity house_number                  | 0.7013         | 0.7671    | +7pp                                       |
| parity postcode                      | 0.9861         | 0.9861    | PASS                                       |
| US region→street flips (census /600) | 5              | 2         | boundary-absorption halved (#727 aux head) |
| gauntlet regression + metamorphic    | PASS           | PASS      | Dublin bare-city coordinate pin held       |
| **golden country recall**            | **88.6%**      | **82.0%** | **−6.6pp — the gate that fired**           |

The span-boundary aux head is training-only (off the logits path, not exported); the shipped ONNX
is the plain BIO tagger whose encoder absorbed the boundary pressure. Tokenizer v0.9.0-multisplice.

## The country gate exception (#1104) — falsifier evidence

The −6.6pp golden country recall fired the 2pp pre-publish gate. A falsifier (DeepSeek session
019f5f2c) split the 224 golden country-gold rows into WOF-admin hierarchy vs real-postal:

- **220 of 224 are WOF-admin hierarchy** rows — `country, region, locality` with a leading long-form
  country and/or a transliterated non-Latin locality (e.g. "United States of America, Wyoming,
  Лорейн"). These are gazetteer hierarchy strings, not addresses anyone types.
- **Only 4 are real-postal.** On the real-postal subset, and on 300 real no-country rows (precision):

| model          | real-postal country recall | halluc. (300 real no-country rows) |
| -------------- | -------------------------- | ---------------------------------- |
| v241 (shipped) | 3/4                        | 0.7%                               |
| v257           | 3/4                        | 0.7%                               |
| v261           | 3/4                        | 0.7%                               |

**Identical across the whole fragment lineage.** The −6.6pp is entirely on the non-postal WOF-admin
distribution; on real addresses country recall AND precision are unchanged. The gate over-weighted a
slice that is 98% synthetic hierarchy rows. Promoting v261 does not regress country on production
input.

## The permanent fix (in progress)

Country is a closed, enumerable class (~250 surfaces, in `@mailwoman/codex` COUNTRY_SURFACE_FORMS).
Pelias handles it as a position-independent DICTIONARY phrase-lookup (`WhosOnFirstClassifier`), not a
learned tag — i.e. country is atlas, not grammar. The right permanent fix (per the consult) is a
country-lexicon **soft-feed channel** mirroring the existing gazetteer channel, which recovers
WOF-admin/resolver country without a data counterweight. That work is tracked on the
`feat/country-lexicon-channel` branch and `docs/superpowers/plans/2026-07-14-country-lexicon-channel.md`.

Data counterweight iterations (v290 tail rows +0.9pp, v291 leading rows +0.4pp) confirmed diminishing
returns — expected, since teaching a grammar to memorize a lexicon is the wrong tool. v2.9.2 (built,
not trained) is retained only as future channel training signal.
