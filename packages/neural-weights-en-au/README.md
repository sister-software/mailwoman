# @mailwoman/neural-weights-en-au

Mailwoman neural-classifier weights for locale `en-au`. Data-only overlay — shares the base
`model.onnx` + `tokenizer.model` from `@mailwoman/neural-weights-en-us` (byte-identical encoder).

## What this package ships

- Country-surface lexicon (shared gazetteer artifact, symlinked from `data/gazetteer/`)
- Street-morphology FST (locale-general, symlinked from `$MAILWOMAN_DATA_ROOT/wof/`)

## What this package does NOT ship (yet)

- **No postcode-au.bin** — no WOF AU postcode database exists. The anchor channel resolves OFF for
  en-au loads. Tracked as a follow-up.
- **No pair-index-au.bin** — PIX1 placetype-pair retrieval not yet calibrated for AU. Needs the
  AU address register (GNAF/OA) for pair extraction.
- **No anchor-lexicon** — the gazetteer channel resolves OFF. Same posture as en-nz.

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
need building — the overlay is lexicons-only at this stage.
