# External validation corpora

Independent test material harvested to evaluate the parser against sources
**outside our own (Pelias-derived) lineage**. Gathered 2026-05-29.

## Why this exists

Our `mailwoman/test/*.test.ts` suite is, on inspection, **largely a port of
Pelias parser + addressit** (`addressit.usa.test.ts` is the verbatim addressit
en-US corpus; `address.*.test.ts` mirror `pelias/parser`'s `test/address.*`).
Our `v0` rule parser is itself Pelias-derived. So "v0 scores 100% on its tests"
is close to tautological, and that suite **cannot reveal v0's deficiencies** —
it shares v0's lineage. We need test cases from *different* lineages.

## Contents

### `postal-standards-catalog.json` (104 examples, 36 countries)
Verbatim example addresses published by postal authorities, tagged by
`edge_class` (intl-format 46, po-box 18, canonical 15, secondary-unit 13,
non-latin 4, military-apofpo 3, rural-route 3, directional 2) and `source`.
Richest sources: Frank's Compulsive Guide to Postal Addresses
(`columbia.edu/~fdc/postal`, via Wayback), the **UPU per-country addressing
files** (`upu.int/.../addressingUnit/*.pdf` — authoritative, from each national
post), Australia Post PDFs, UPS API spec. Notable traps captured: US military
APO/FPO/DPO + AA/AE/AP pseudo-states; non-Latin/RTL (Persian, Cyrillic w/
transliteration pairs); Japan block numbering (`chome-ban-go`); German `//`
unit separator; unit-before-number hyphen (`6-123`, Canada Post `123-45`);
PO-box variety (Apartado, A.A., Postfach/Packstation, BP/CEDEX, Private Bag,
GPO Box, alphanumeric `PO Box HM 100`).

Fields per row: `{raw, country, edge_class, standardized, source}`.

### `postal-cases.jsonl` (38 labeled, in-scope subset)
The labeled, runnable cut of the catalog: the 38 in-scope English-Latin
addresses (US/GB/CA/AU/NZ/IE — excludes the non-Latin/RTL/Japan-block rows,
which are out of the en-US/fr-FR model's scope, and the USPS `##` format
templates, which aren't real addresses). Labeled into our schema
DeepSeek-assisted then spot-checked: every surface form is verified verbatim
against `raw`, and the tricky calls (military APO/region mapping,
unit-before-number `6-123`, county-as-region `CO. ARMAGH`, district-as-
dependent_locality `HIGH PEAK`) were reviewed by hand. Personal recipient
names are intentionally unlabeled (no schema tag). Fields:
`{input, locale, expected, edge_class, country, source}`.

**v0 baseline (model-independent, 2026-05-30):** v0 26% overall — wins on
canonical/intl-format/secondary-unit (29–43%, its rule turf), **0% on military
APO/FPO, PO-box, rural-route, directional** (coverage gaps shared with neural).

Gaps: USPS Pub 28 worked examples are JPG images (need OCR); Canada Post are SVG
images; Royal Mail PDF 403'd. The US/UK/CA filled examples here come from
Frank's guide / UPU instead.

## The highest-value runnable benchmark: libpostal

`openvenues/libpostal` (MIT) — the canonical *statistical* address parser, a
genuinely different architecture from Pelias. Its `test/test_parser.c` (~60
hand-curated, deliberately adversarial cases: house-number ranges `912-914`,
`92-10`; `Mc Carroll` splits; `apt. 3a`/`#104`/`6th Floor` sub-premise;
venue+org prefixes; multilingual) is NOT in our suite and converts mechanically
to `{input, expected}` with a tag remap:

| libpostal | ours |
| --- | --- |
| road | street |
| city | locality |
| state | region |
| house | venue |
| house_number, unit, po_box, postcode, country | (same) |
| city_district, suburb, level, staircase, entrance | no clean 1:1 — fold/ignore |

Compare case-insensitively (libpostal lowercases/normalizes components). The
archive.org bulk TSV (88 countries, ~1.2 GB) is the heavyweight option for scale.

## Running the arenas

All three arenas run through one push-button script:

```bash
yarn compile   # harness resolves @mailwoman/neural to its compiled out/ tree
# default shipped weights:
scripts/eval/external-arenas.sh
# against a fresh export (e.g. v0.7.2 int8):
MODEL=/path/model.int8.onnx TOKENIZER=/path/tokenizer.model \
  MODELCARD=/path/model-card.json scripts/eval/external-arenas.sh
```

It regenerates the perturbation arena, runs each arena with `--symmetric-match
--postcode-repair`, and prints the three-bucket table (neural-only / both /
v0-only / both-fail) per arena plus a by-edge_class breakdown for the postal
arena (`scripts/eval/summarize-arenas.py`).

## Done / next

1. ✅ Harvested `libpostal/test/test_parser.c` → `libpostal-cases.jsonl` (69).
2. ✅ Labeled the in-scope catalog subset → `postal-cases.jsonl` (38).
3. ✅ Push-button runner (`external-arenas.sh`) + three-bucket summarizer.
4. ⏳ Re-run all three against the v0.7.2 model for the final capability table
   (the default shipped weights are the stale v0.5.3 bundle — neural numbers
   from a default run are not representative).
