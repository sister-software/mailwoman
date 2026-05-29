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
**Note:** these are RAW (no per-component ground truth yet). Labeling into
`{input, expected components}` (DeepSeek-assisted + spot-checked) is the next
step before they're runnable through the harness.

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

## Next steps

1. Harvest `libpostal/test/test_parser.c` → remap → runnable `{input, expected}`.
2. Label the postal-standards catalog into components (DeepSeek + spot-check).
3. Run both through `harness-v0-neural` → the three-bucket capability table
   (neural-only wins / both / v0-only) by edge-class — the eval our current
   suite structurally can't produce.
