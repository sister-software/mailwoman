# @mailwoman/neural-weights-en-au

Mailwoman neural-classifier weights for locale `en-au`. Data-only overlay — shares the base
`model.onnx` + `tokenizer.model` from `@mailwoman/neural-weights-en-us` (byte-identical encoder).

## What this package ships

- Country-surface lexicon (shared gazetteer artifact, symlinked from `data/gazetteer/`)
- Street-morphology FST (locale-general, symlinked from `$MAILWOMAN_DATA_ROOT/db/wof/`)

## What this package does not ship (yet)

- **No postcode-au.bin** — no WOF AU postcode database exists. The anchor channel resolves off for
  en-au loads. Tracked as a follow-up.
- **No pair-index-au.bin** — PIX1 placetype-pair retrieval not yet calibrated for AU. Needs the
  AU address register (GNAF/OA) for pair extraction.
- **No anchor-lexicon** — the gazetteer channel resolves off. Same posture as en-nz.

## Purpose (2026-08-08)

This overlay exists so `--locale en-AU` resolves and the resolver's country scope constrains the
candidate lookup. The 2026-08-07 FIRST-PASS benchmark found 8 Western Australia rows misrouting
≥15,000 km under the en-US production default because "WA" was read as Washington State. The
locale's country scope (AU) fixes that class without any model change or training.

## Dev setup

```bash
node scripts/link-dev-weights.ts
```

Links the country lexicon and street-morphology FST into the package dir. No derived artifacts
need building. At this stage the package ships only the two lexicon files.

## Attribution

This overlay decodes through the `@mailwoman/neural-weights-en-us` model graph, which trained on
address rows derived from OpenStreetMap. A consumer of this package alone receives rows that graph was
trained to read, so the notice applies here too:

> © OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0
> (https://opendatacommons.org/licenses/odbl/1-0/); see https://www.openstreetmap.org/copyright.

`LICENSE.md` in this package repeats the base graph's required attributions, and
https://mailwoman.ai/resources/osm/attribution explains how Mailwoman reads the license.
