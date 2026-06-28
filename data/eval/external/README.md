# External validation corpora

Independent test material harvested to evaluate the parser against sources
**outside our own (Pelias-derived) lineage**. Gathered 2026-05-29.

## Why this exists

Our `mailwoman/test/*.test.ts` suite is, on inspection, **largely a port of
Pelias parser + addressit** (`addressit.usa.test.ts` is the verbatim addressit
en-US corpus; `address.*.test.ts` mirror `pelias/parser`'s `test/address.*`).
Our `v0` rule parser is itself Pelias-derived. So "v0 scores 100% on its tests"
is close to tautological, and that suite **cannot reveal v0's deficiencies** —
it shares v0's lineage. We need test cases from _different_ lineages.

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

`openvenues/libpostal` (MIT) — the canonical _statistical_ address parser, a
different architecture from Pelias. Its `test/test_parser.c` (~60
hand-curated, deliberately adversarial cases: house-number ranges `912-914`,
`92-10`; `Mc Carroll` splits; `apt. 3a`/`#104`/`6th Floor` sub-premise;
venue+org prefixes; multilingual) is NOT in our suite and converts mechanically
to `{input, expected}` with a tag remap:

| libpostal                                         | ours                       |
| ------------------------------------------------- | -------------------------- |
| road                                              | street                     |
| city                                              | locality                   |
| state                                             | region                     |
| house                                             | venue                      |
| house_number, unit, po_box, postcode, country     | (same)                     |
| city_district, suburb, level, staircase, entrance | no clean 1:1 — fold/ignore |

Compare case-insensitively (libpostal lowercases/normalizes components). The
archive.org bulk TSV (88 countries, ~1.2 GB) is the heavyweight option for scale.

## `openaddresses-us-sample.jsonl` (10,000 US records, 7 states) — the OA track

The **coordinate ground-truth** set for the resolver/geocoder end-to-end eval
("OA track" of Direction C). Each record is a real US address with a real
lat/lon harvested from **OpenAddresses (OA)** — an aggregation of authoritative
government address points. This set is _independent of the WOF gazetteer_ the
resolver consults, so it can measure the great-circle error from the resolver's
admin centroid to OA's real point without circularity.

Built by [`scripts/eval/ingest-openaddresses.ts`](../../../scripts/eval/ingest-openaddresses.ts).
Gathered 2026-05-30. Regenerate with:

```bash
node scripts/eval/ingest-openaddresses.ts \
  --out data/eval/external/openaddresses-us-sample.jsonl \
  --cache /tmp/oa-cache --target 10000 --per-state 1500 --seed 42
```

A machine-readable provenance/quality report (per-source read/kept/dropped
counts + the packaged-license string from each zip's `README.txt`) is written
next to the data as `openaddresses-us-sample.report.json`.

### Row schema

```json
{
	"input": "5210 South Ingleside Avenue, Chicago, IL 60615",
	"lat": 41.8004427,
	"lon": -87.6031768,
	"expected": { "locality": "Chicago", "region": "IL", "postcode": "60615" },
	"state": "IL",
	"source": "openaddresses:us/il/cook"
}
```

`input` is a human-style address string rendered as
`"{number} {street}, {city}, {region} {postcode}"` from the OA components
(all-caps / all-lower city & street are title-cased; the harness matcher is
case-insensitive anyway). `lat`/`lon` are OA's point coordinate (the ground
truth). `expected` carries only the **admin-level** fields the resolver
produces — `locality`/`region`/`postcode` (no street geometry).

### Sampling method

- Only a **handful of specific OA source files** are downloaded (NOT the
  multi-GB US collection), stratified across dense-urban / suburban / rural so
  no single state dominates.
- Each source is streamed out of its zip (`unzip -p`, no full extraction),
  normalized, then **filtered**: drop rows missing city OR postcode (resolver
  is admin-level), drop a house-number-with-no-street, drop streets that are
  purely numeric, drop points outside a US lat/lon sanity box, and require a
  house number in the rendered string. Postcodes are normalized to 5-digit ZIP
  (a stray `.0` float suffix is stripped; ZIP+4 is truncated to ZIP).
- **Dedup** within a source on `(number, street, city, postcode)`.
- **Stratified reservoir sample** (deterministic, seeded mulberry32 PRNG) to
  `--per-state` survivors per state, then a round-robin trim to `--target`
  total — yielding ~1,429 records per state at the 10k/7-state default.

### Sources used (OpenAddresses "latest run" aggregates)

Canonical host:
`https://results.openaddresses.io/latest/run/<country>/<state>/<source>.zip`
(302-redirects to `data.openaddresses.io` → Cloudflare R2). Each zip holds a
CSV with header `LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH`.

| Source key (`openaddresses:<key>`) | State | Tier                   | zip size | Upstream authority                               | Packaged license                                                    |
| ---------------------------------- | ----- | ---------------------- | -------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `us/ca/berkeley`                   | CA    | dense-urban            | 0.7 MB   | City of Berkeley open data                       | (Unknown in zip; CA open gov)                                       |
| `us/ca/marin`                      | CA    | suburban-west          | 2.9 MB   | Marin County GIS                                 | (Unknown in zip; CA open gov)                                       |
| `us/il/cook`                       | IL    | dense-urban            | 34 MB    | Cook County (Chicago metro) GIS                  | (Unknown in zip; IL open gov)                                       |
| `us/dc/statewide`                  | DC    | urban-district         | 3.8 MB   | DCGIS                                            | https://dc.gov/page/terms-and-conditions-use-district-data          |
| `us/ia/statewide`                  | IA    | suburban/rural midwest | 54 MB    | Iowa county GIS (aggregate)                      | (Unknown in zip; per-county open gov)                               |
| `us/mt/statewide`                  | MT    | rural-west             | 17 MB    | Montana State Library + county GIS               | (Unknown in zip; MT open gov)                                       |
| `us/vt/statewide`                  | VT    | rural-northeast        | 11 MB    | Vermont Center for Geographic Information (VCGI) | http://vcgi.vermont.gov/.../VCGI_Warranty_Copyright_Notice_2013.pdf |
| `us/sd/statewide`                  | SD    | rural-plains           | 8 MB     | South Dakota county GIS                          | (Unknown in zip; SD open gov)                                       |

**Rejected (documented in the script's `SOURCES` comment):** `us/ca/san_francisco`
and `us/wy/statewide` carry NO city/place column — every row drops on the city
filter — so SF was replaced by Berkeley+Marin and Wyoming was omitted.

### License / attribution

OpenAddresses aggregates **open government data**; the OA collection itself is
distributed under permissive terms (predominantly public-domain / CC-BY /
attribution). Per-source licenses vary by upstream authority — the
authoritative string is in each source's definition at
`github.com/openaddresses/openaddresses/sources/...` and the packaged
`README.txt` inside each zip (captured verbatim in the `.report.json`, e.g. DC →
dc.gov terms, VT → VCGI warranty notice). This sample is for an **internal
eval only** (not redistributed and not used for training), but if any derived
artifact is ever published, attribute **OpenAddresses** and the upstream
authorities listed above (e.g. "Address data © OpenAddresses contributors and
the respective US government agencies").

### Manual download (if egress is blocked)

The ingest script uses `curl -L`; if the environment blocks it, fetch the zips
by hand into the cache dir and re-run with `--offline`:

```bash
for kv in us/ca/berkeley us/ca/marin us/il/cook us/dc/statewide \
          us/ia/statewide us/mt/statewide us/vt/statewide us/sd/statewide; do
  ! curl -sSL -o "/tmp/oa-cache/$(echo "$kv" | sed 's#/#__#g').zip" \
      "https://results.openaddresses.io/latest/run/$kv.zip"
done
node scripts/eval/ingest-openaddresses.ts --offline \
  --out data/eval/external/openaddresses-us-sample.jsonl --cache /tmp/oa-cache
```

## German (DE) — multi-locale probe (2026-06-02)

Two German sets from OpenAddresses Berlin + Saxony support the multi-locale work:

- **`openaddresses-de-sample.jsonl`** (3,000 records) is the _resolver_ eval set
  (admin-level: `expected` carries `locality`/`region`/`postcode`). Built by the
  same `ingest-openaddresses.ts`, selected with `--sources de/berlin,de/sn/statewide`.
- **`openaddresses-de-golden.jsonl`** (1,500 records, held-out seed 7) is the
  _parser_ eval set (`{raw, components}` with street + house_number), rendered in
  idiomatic German order. Built by `build-german-shard.mjs --golden`.

Two changes make non-US OpenAddresses usable here:

1. **Per-source `bbox`** in the ingest `SOURCES` registry. The geo-sanity filter
   defaulted to a continental-US box (lon −180..−60), which silently dropped every
   German point. Non-US sources now set their own `bbox` (DE: lat 47..56, lon 5..16).
2. **`--default-country`** on `oa-resolver-eval.ts`. The resolver applies the
   default as a HARD country filter, so hardcoding `"US"` sent every German address
   to a US namesake (`Berlin` resolved to a 20k-pop US Berlin, coord ~5,940 km). Pass
   `--default-country DE` (or `none`) for non-US data and the coord drops to ~10 km.

The German _training_ shard (`synth-german`, `corpus/src/synthesize-german.ts`)
renders these real DE tuples in German order via the OpenCage `DE` template, so the
model learns house-number-after-street and postcode-before-city. Run the German
before/after with `node scripts/eval-de-coverage.ts <model> <tokenizer> <model-card>`.

## Running the arenas

All three arenas run through one push-button script:

```bash
yarn compile   # harness resolves @mailwoman/neural to its compiled out/ tree
# default shipped weights:
node --experimental-strip-types scripts/eval/external-arenas.ts
# against a fresh export (e.g. v0.7.2 int8):
MODEL=/path/model.int8.onnx TOKENIZER=/path/tokenizer.model \
  MODELCARD=/path/model-card.json node --experimental-strip-types scripts/eval/external-arenas.ts
```

It regenerates the perturbation arena, runs each arena with `--symmetric-match
--postcode-repair`, and prints the three-bucket table (neural-only / both /
v0-only / both-fail) per arena plus a by-edge_class breakdown for the postal
arena (`scripts/eval/summarize-arenas.ts`).

## Done / next

1. ✅ Harvested `libpostal/test/test_parser.c` → `libpostal-cases.jsonl` (69).
2. ✅ Labeled the in-scope catalog subset → `postal-cases.jsonl` (38).
3. ✅ Push-button runner (`external-arenas.ts`) + three-bucket summarizer.
4. ✅ Wired `openaddresses-us-sample.jsonl` into the resolver end-to-end eval
   (`scripts/eval/resolver-eval.ts` + the OA admin-match runner): resolve each
   `input` → admin centroid, great-circle error to `lat`/`lon` by state.
5. ⏳ Re-run all three arenas against the v0.7.2 model for the final capability
   table (the default shipped weights are the stale v0.5.3 bundle — neural
   numbers from a default run are not representative).
