---
title: "Decoder exposure gaps — measured on the 2026-10-02 OpenStreetMap extracts"
description: Which address phenomena eight under-covered jurisdictions supply at each pipeline stage, what the shipped decoder does on contrast cases, and the exposure curve for Russia.
---

# Decoder exposure gaps — measured on the 2026-10-02 OpenStreetMap extracts

This record measures what address phenomena the decoder can be exposed to in eight jurisdictions —
RU, CN, IN, ID, NG, PK, BD and VN — and what the shipped decoder does on contrast cases that share a
surface form. It keeps three layers apart:

- **Convention observation**: what a published layout states (`packages/codex/lib/address/convention-claims.ts`).
- **Corpus observation**: what source rows contain (`corpus-python/src/mailwoman_train/exposure/`).
- **Decoder observation**: what a trained graph does on controlled inputs (the contrast board and the
  exposure-curve grades).

A number in one layer is evidence for that layer only.

## Inputs

| input            | value                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extracts         | Geofabrik `-latest` for the eight regions, `Last-Modified` 2026-10-02 (Nigeria 2026-10-03); each has a `<pbf>.receipt.json` with URL, bytes, sha256 and Geofabrik's md5 |
| Country outlines | geoBoundaries gbOpen ADM0 per country, receipts beside each under `$MAILWOMAN_DATA_ROOT/db/osm/outlines/`                                                               |
| Code revision    | `265a7257d` plus this arc's uncommitted working tree                                                                                                                    |
| Label set        | `stage3`, semantic tag registry version 1                                                                                                                               |
| Corpus version   | `0.19.1-osm-exposure` (overlay of `0.19.0-suffix-boundary-v2`)                                                                                                          |
| Date             | 2026-10-03                                                                                                                                                              |

## The acquisition funnel

Each row reads left to right. Every reduction has a counted reason in the adapter manifest's
`dropped` map, and each country reconciles: records written minus rows refused equals rows yielded.

| country | PBF features with `addr:housenumber` | outside the country outline | rows refused by the adapter |    yielded | removed by dedup | canonical rows | train / val / test                 |
| ------- | -----------------------------------: | --------------------------: | --------------------------: | ---------: | ---------------: | -------------: | ---------------------------------- |
| RU      |                           12,185,479 |                     146,991 |                   1,067,856 | 10,970,448 |        4,516,689 |      6,453,759 | 1,996,290 / 1,924 / 1,963 (sample) |
| CN      |                              158,215 |                      73,490 |                      21,596 |     63,124 |           11,569 |         51,555 | 50,963 / 267 / 325                 |
| IN      |                              134,700 |                       3,812 |                      63,458 |     67,388 |            9,784 |         57,604 | 51,534 / 3,026 / 3,044             |
| ID      |                              105,393 |                         195 |                      31,496 |     73,660 |           17,264 |         56,396 | 53,012 / 1,696 / 1,688             |
| PK      |                              103,899 |                         110 |                       7,033 |     96,756 |           15,255 |         81,501 | 79,482 / 1,007 / 1,012             |
| VN      |                               84,279 |                         473 |                       8,965 |     74,840 |            5,869 |         68,971 | 68,482 / 227 / 262                 |
| BD      |                               23,181 |                          53 |                       4,342 |     18,786 |            7,415 |         11,371 | 11,122 / 120 / 129                 |
| NG      |                                8,414 |                           8 |                       1,267 |      7,139 |              377 |          6,762 | 6,702 / 24 / 36                    |

The manifests under `/mnt/mw/corpus-staging/exposure-2026-10-03/<cc>/osm/MANIFEST.json` hold every
count by reason. Russia's overlay rows are a 2,000,177-row sample of its 6,453,759 canonical rows: the
rows whose `sha256(source_id)` falls in the lowest 31% of the hash space. Every Russian count in this
record outside the split column reads the full canonical set. Russia's 4,516,689 duplicates are one
address mapped on both a node and its building way.

The largest explained reductions are properties of the sources:

- **CN, outside the outline: 73,490 of 158,215.** Geofabrik's China extract includes Hong Kong and
  Macau, which ISO 3166 codes as HK and MO, and addresses across the Russian border. Before the
  outline check, 5,629 of 112,608 CN canonical rows (5.0%) were written in Cyrillic, 1,719 of them in
  Zabaykalsk. After it, 8 of 51,542 are. The China outline is coarse (97,329 bytes), so the Russian
  outline (6,943,733 bytes) is applied as an exclusion: a point inside a neighbor's outline is refused
  even where China's coarse outline also contains it.
- **IN, streetless records with no locality: 35,098.** 45,819 of India's 64,275 streetless records carry
  `addr:housenumber` and no other address tag, so they state a number without a place.
- **Every country, `component:house_number:not-designator`.** Mappers write whole lines into
  `addr:housenumber` (`House 34, Road 4, Sector 9`). The row keeps its street and loses the number.
- **CN, `component:unit:not-rendered`: 629.** The CN layout prints no unit slot, so those rows lose
  the unit component in rendering.

## Corpus observation: phenomena in the canonical rows

Counts are rows exercising each form. A blank cell is a measured zero.

| country | canonical rows | streetless premise | house number vs street | six-digit postcode | other postcode widths | premise subdivision | planning word in a locality           |
| ------- | -------------: | -----------------: | ---------------------- | -----------------: | --------------------- | ------------------- | ------------------------------------- |
| RU      |      6,453,759 |            493,285 | after: 5,816,687       |          1,306,279 | 5: 161, 4: 1          | unit: 373           |                                       |
| CN      |         51,555 |             11,936 | after: 35,498          |              9,407 | 5: 34, 4: 5           |                     |                                       |
| IN      |         57,604 |             12,377 | before: 33,608         |             34,466 | 5: 168, 4: 16         | unit: 387           | sector 474, phase 424, block 54       |
| ID      |         56,396 |             15,090 | after: 38,569          |                 22 | 5: 15,739, 4: 45      | unit: 897           |                                       |
| PK      |         81,501 |              1,524 | before: 78,346         |                  8 | 5: 2,900, 4: 28       | unit: 98            | phase 14,934, block 7,425, sector 785 |
| VN      |         68,971 |              4,248 | before: 63,667         |              1,689 | 5: 1,623, 4: 98       | unit: 420           |                                       |
| BD      |         11,371 |                221 | before: 9,715          |                    | 4: 3,838, 5: 6        | unit: 39            | sector 11                             |
| NG      |          6,762 |                 12 | before: 6,652          |                437 | 5: 21, 4: 12          | unit: 1             | phase 2                               |

Before this arc, the corpus held 0 Russian rows, and China's 7,624,794 rows included none with a
street. The OSM rows supply 5,816,687 Russian and 35,498 Chinese rows with a street and a house number.

`ordering-reverses-with-script` measured 0 paired examples: the OSM adapter emits one rendering per
object, so no canonical row has a second-script twin. `numeric-shape-across-contexts` is available in
every pair of six-digit counts above, for example 1,306,279 × 34,466 RU–IN pairs. The full pair counts
are in `exposure-canonical-8.json` under `pairs`.

## Convention observation

The libaddressinput-derived claims after the §9 fixes, over 248 jurisdictions with a population
record (47 with no layout):

| claim                           | supports | contradicts | silent |
| ------------------------------- | -------: | ----------: | -----: |
| `postcode-precedes-locality`    |       97 |          77 |     27 |
| `house-number-precedes-street`  |       98 |          95 |      8 |
| `largest-unit-first`            |        8 |          65 |    128 |
| `ordering-reverses-with-script` |        7 |           1 |    193 |
| `streetless-premise-identity`   |        0 |           0 |    201 |
| `premise-subdivision-present`   |        0 |           0 |    201 |
| `fixed-width-numeric-postcode`  |        0 |           0 |    201 |
| `planning-word-names-locality`  |        0 |           0 |    201 |

`ordering-reverses-with-script` now compares pairwise order. The seven supporting jurisdictions are
CN, HK, JP, KP, KR, MO and TW; TH contradicts. Under the previous full-reversal rule it read 0.
`streetless-premise-identity` reads a layout as support only when it prints a house number and a
locality with no street slot, and no libaddressinput layout does, so the corpus counts above are the
evidence for that phenomenon.

## Decoder observation: the contrast board

Twelve rows in four groups, all `status: pass`, on the shipped `neural-weights-en-us` graph (md5
`98a49b5c`). The regression layer graded 539 of 609 counted rows; 8 of its 70 failures are these.

| row                                        | input                                                                                  | result | first wrong label                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| `in-contrast-six-digit-postcode-in`        | `Rashtrapati Bhavan, New Delhi, Delhi 110004, India`                                   | pass   |                                                                      |
| `cn-contrast-six-digit-postcode-cn-latin`  | `100 Renmin Road, Huangpu District, Shanghai 200001, China`                            | pass   |                                                                      |
| `cn-contrast-six-digit-postcode-cn-native` | `上海市黄浦区人民路100号 200001`                                                       | pass   |                                                                      |
| `ru-contrast-six-digit-postcode-ru-latin`  | `Tverskaya ulitsa 13, Moscow 125032, Russia`                                           | pass   |                                                                      |
| `ru-contrast-six-digit-postcode-ru-native` | `Тверская улица, 13, Москва, 125032, Россия`                                           | fail   | `street "Москва"`, `locality "Россия"`                               |
| `in-contrast-sector-planning-locality`     | `House 4, Sector 12, Gurugram, Haryana 122001, India`                                  | fail   | `venue "Sector"`, `street "Haryana"`                                 |
| `in-contrast-sector-street`                | `12 Sector Road, Gurugram, Haryana 122001, India`                                      | fail   | `region null`; the contrast assertion `dependent_locality ""` passes |
| `in-contrast-block-premise-subdivision`    | `Flat 12, Block B, Sunshine Apartments, Sector 21, Noida, Uttar Pradesh 201301, India` | fail   | `locality "Uttar Pradesh"`                                           |
| `pk-contrast-block-planning-locality`      | `House 12, Block B, North Nazimabad, Karachi 74700, Pakistan`                          | fail   | `venue "Block"`, `unit "House 12"`                                   |
| `cn-contrast-script-native`                | `上海市黄浦区人民路100号`                                                              | fail   | the harness reads the whole line as `street`                         |
| `cn-contrast-script-mixed`                 | `上海市Huangpu区人民路100号`                                                           | fail   | the whole line as `street`                                           |
| `cn-contrast-script-omitted-level`         | `上海市人民路100号`                                                                    | fail   | `street null`, `region null`                                         |

The six-digit shape is read as a postcode in four of five contexts. The Russian native arm reads the
postcode and misplaces every word around it. The corpus held zero Russian rows when that graph trained.

### The shipped graph on Russia's held-out rows

`grade_exposure` scored the shipped v4.4.0 step-60000 checkpoint on the 1,963 `osm-ru` test rows, the
Primorsky Krai holdout. A row counts as correct when every labeled position matches.

| group                                    | correct / rows | exact match |
| ---------------------------------------- | -------------: | ----------: |
| all rows                                 |    682 / 1,963 |       0.347 |
| `house-number-precedes-street=after`     |    682 / 1,792 |       0.381 |
| `fixed-width-numeric-postcode=6-digit`   |        0 / 875 |       0.000 |
| `postcode-precedes-locality=after`       |        0 / 642 |       0.000 |
| `streetless-premise-identity=streetless` |         0 / 15 |       0.000 |

No Russian row with a postcode parses exactly. The contrast row above shows the same result on one
address: the postcode slot is right and the words around it are wrong.

## The Russian exposure curve (v4.15.0)

Five fine-tunes of the shipped v4.4.0 step-60000 graph, 2,000 steps each at lr 1e-5 cosine with the
EWC brake at 1e4, seed 42, differing only in `source_weights.osm-ru`
(`corpus-python/src/mailwoman_train/configs/v4.15.0-ru-exposure-d*-2k.yaml`). The d0 arm draws no
Russian row and is the placebo: its change from the shipped graph is the cost of fine-tuning at all.
Each arm's epoch-mixture receipt passed before its GPU started; the d100 arm's audit drew 396 `osm-ru`
rows in 1,000,000 against an expectation of 390.7.

Realized draws are the trainer's own count of RU rows in consumed batches
(`exposure-realized-from-0.json` beside each checkpoint). The assembled curve is
`$MAILWOMAN_DATA_ROOT/corpus-staging/exposure-2026-10-03/curve/curve-ru.json`, written by
`python -m mailwoman_train.exposure.curve` from those files and the `grade_exposure` reports. Results are exact-match rows on the 1,963 RU
test rows; the shipped graph reads 682.

| arm     | `osm-ru` weight | expected draws | realized RU draws |            all rows | six-digit postcode | house number after street | postcode after locality | streetless |
| ------- | --------------: | -------------: | ----------------: | ------------------: | -----------------: | ------------------------: | ----------------------: | ---------: |
| d0      |             0.0 |              0 |                 0 | 693 / 1,963 (0.353) |            0 / 875 |               693 / 1,792 |                 0 / 642 |     0 / 15 |
| d100    |         0.06292 |            100 |               115 |         719 (0.366) |            0 / 875 |               719 / 1,792 |                 0 / 642 |     0 / 15 |
| d1000   |         0.63137 |          1,000 |               930 |         829 (0.422) |            0 / 875 |               829 / 1,792 |                 0 / 642 |     0 / 15 |
| d10000  |         6.54472 |         10,000 |             9,683 |         977 (0.498) |            3 / 875 |               977 / 1,792 |                 3 / 642 |     0 / 15 |
| d100000 |       103.20513 |        100,000 |            98,999 |       1,523 (0.776) |  541 / 875 (0.618) |             1,514 / 1,792 |               508 / 642 |     0 / 15 |

The trainer's realized draws by phenomenon, the exposure the decoder actually received:

| arm     | RU rows drawn | with a six-digit postcode | streetless premise | house number after street |
| ------- | ------------: | ------------------------: | -----------------: | ------------------------: |
| d0      |             0 |                         0 |                  0 |                         0 |
| d100    |           115 |                        19 |                  3 |                       108 |
| d1000   |           930 |                       231 |                 41 |                       858 |
| d10000  |         9,683 |                     2,239 |                280 |                     9,091 |
| d100000 |        98,999 |                    20,417 |              7,249 |                    87,770 |

The held-out six-digit-postcode rows went from 3 exact of 875 at 2,239 drawn to 541 at 20,417 drawn.

Every stage of the chain is measured for Russia under the d10000 arm's config. Stage counts are RU
rows. The replayed epoch is the epoch-mixture audit's 1,000,000 draws, and the realized draws are the
2,000-step run's 256,000.

| stage                                                 |       rows | six-digit postcode | streetless premise | house number after street |
| ----------------------------------------------------- | ---------: | -----------------: | -----------------: | ------------------------: |
| PBF features with `addr:housenumber`                  | 12,185,479 |                    |                    |                           |
| canonical rows                                        |  6,453,759 |          1,306,279 |            493,285 |                 5,816,687 |
| eligible training rows (the 31% sample's train split) |  1,996,290 |            402,342 |            152,942 |                 1,799,245 |
| replayed draws, epoch 1 of 1,000,000                  |     39,286 |              9,333 |              1,187 |                    36,839 |
| realized draws in the 2,000-step run                  |      9,683 |                    |                    |                           |

Attributed against the placebo, the Russian rows add 26 exact rows at 115 draws (719 − 693), 136 at
930, 284 at 9,683 and 830 at 98,999. The two phenomena separate:

- **Street rows without a postcode** improve from the first thousand draws.
- **Rows with a six-digit postcode** stay at 0 through 9,683 draws and reach 541 of 875 at 98,999. The
  threshold lies between 10,000 and 100,000 draws, and the curve has not flattened at 100,000.

**No floor is set.** A floor is the exposure at which behavior is stable, and at 98,999 draws the
postcode rows are still rising. `exposure/floors.json` stays empty until a longer arm shows the
plateau. The 15 streetless held-out rows are too few to read a result from.

### What the Russian rows cost the rest of the board

`mwdev_arc` grades each arm's int8 export on the 1,041-row regression board against the shipped
graph, with the shipped graph staged as a self-control and the d0 arm as the placebo. The arms are
measurement arms, not ship candidates; the board says whether exposure to Russian rows moves any
other locale.

| leg vs shipped v4.4.0                | improved | regressed | net | rows differing |
| ------------------------------------ | -------: | --------: | --: | -------------: |
| self-control (shipped graph, staged) |        0 |         0 |   0 |      0 / 1,041 |
| placebo d0                           |        0 |         8 |  −8 |     71 / 1,041 |
| d1000                                |        5 |         5 |   0 |     77 / 1,041 |
| d100000                              |       47 |        62 | −15 |    439 / 1,041 |

At 98,999 draws, 39% of the run, the Russian rows cost the rest of the board: attributable net −7 =
d100000 net −15 − placebo net −8. The D-rule blocks the arm on GB (7 rows), DE (1) and US (1), and 24
of its 62 regressions are Singapore rows (`Blk 13 Mount Rosie Terrace #23-242 Singapore 308015` and
23 more). The same arm moves three contrast rows:

| contrast row                                                  | shipped          | d100000   |
| ------------------------------------------------------------- | ---------------- | --------- |
| `Тверская улица, 13, Москва, 125032, Россия`                  | fail             | pass      |
| `House 12, Block B, North Nazimabad, Karachi 74700, Pakistan` | fail             | pass      |
| `12 Sector Road, Gurugram, Haryana 122001, India`             | fail on `region` | regressed |

The exposure that teaches the six-digit Russian postcode, between 10,000 and 100,000 draws on a
2,000-step fine-tune, is also the exposure at which a single-country share displaces the tier-1
locales. A shippable dose for Russia therefore needs a longer run at a smaller share, or the
from-scratch v7.1.0 config, whose 399,258 Russian draws are 5.2% of 7,680,000.

Attributable to the Russian rows at 930 draws: net +8 = d1000 net 0 − placebo net −8. The one
tier-1 regression, `Madison Square West` (US), also regresses in the placebo, so it is the cost of
the fine-tune rather than of the Russian rows. The d1000 regressions outside the placebo's are
`SHIS EQL 6/8 Módulo C, Setor de Habitações Individuais Sul, Brasília`,
`Gandantegchinlen Monastery / Гандантэгчинлэн хийд, Улаанбаатар, Монгол / BGD - 16 khoroo, Ulaanbaatar 16040, Mongolia`,
`BLK 11 CHANGI SOUTH LN #08-372 SINGAPORE 486154` and `BELLE VUE RESIDENCES, 29 OXLEY WK, SINGAPORE 238597`.

## Gap states

| phenomenon                                  | state                               | evidence                                                                            |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| Russian street and premise grammar          | unseen                              | 0 corpus rows before this arc; 0 of 875 held-out rows with a postcode parse exactly |
| Chinese street rows                         | unseen before this arc, now sourced | 35,498 OSM rows with a street; none in the prior corpus                             |
| Streetless premise identity                 | sparse                              | 493,285 RU, 12,377 IN and 11,936 CN rows now sourced; no layout states it           |
| Planning words (`Sector`, `Block`, `Phase`) | confusable                          | 22,000+ PK and 900+ IN rows; both `sector` contrast arms and the `block` arms fail  |
| Six-digit postcode across contexts          | confusable in RU native only        | four of five contrast arms pass                                                     |
| Script-dependent order                      | unseen as pairs                     | 0 paired examples; the CN script arms fail                                          |
| Premise subdivision                         | sparse                              | at most 897 rows per country                                                        |

## Decisions recorded

- **Semantic tags.** One global id per concept (`semantic_tags.py`, version 1). `prefecture`,
  `municipality`, `district`, `block`, `sub_block` and `building_number` project onto the stage3 tags
  SCHEMA.mdx says they refine. `locality_unit`, `building_name`, the stage4 tags and the two JS-only
  tags have no documented equivalent and are counted as unrepresentable rather than written as `O`.
- **Wallonia.** `addressNumberExtension` is ICAR's box number, rendered as `unit` without a designator
  word. Stage4 activation is a separate decision and is not taken here.
- **OSM rows per country.** Each country's rows carry their own source id (`osm-ru` … `osm-bd`), so
  country admission, source admission and sampling weight are three settings.
- **Holdouts.** Each of the eight countries has a declared holdout. NG's is 24 val and 36 test rows,
  which is too few to read a phenomenon from.

## Open decisions

- **CN district tag.** `黄浦区` is `municipality` on the CJK head and `dependent_locality` on the Latin
  head, and SCHEMA.mdx defines neither for CN. The contrast rows leave it unasserted.
- **CN Han rows and the model family.** The 50,963 `osm-cn` train rows are Han script, which routes to
  the CJK character family. The Latin config weights them at zero.

## Where each artifact lives

| artifact                         | location                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OSM receipts and funnel counts   | `$MAILWOMAN_DATA_ROOT/db/osm/geofabrik/*.receipt.json`, `db/osm/corpus/*.stats.json`, each adapter `MANIFEST.json` `dropped` map                               |
| Country outlines                 | `$MAILWOMAN_DATA_ROOT/db/osm/outlines/<ISO3>-ADM0.geojson` with receipts; `packages/osm/tools/fetch/country-outline.ts`, `packages/osm/sdk/country-outline.ts` |
| Shared semantic tag registry     | `corpus-python/src/mailwoman_train/semantic_tags.py`; model cards carry `semantic_tags`                                                                        |
| New-country config with holdouts | `corpus-python/src/mailwoman_train/configs/v7.1.0-osm-exposure-60k.yaml`; `defaultHoldouts()` in `packages/corpus/lib/utils/split.ts`                          |
| Wallonia decision and rendering  | `packages/corpus/lib/be/adapters/wallonie/adapter.ts`                                                                                                          |
| Exposure measurement             | `corpus-python/src/mailwoman_train/exposure/` (`phenomena.py`, `report.py`, `cli.py`); `exposure-canonical-8.json`                                             |
| v1 phenomenon definitions        | `phenomena.py`, with ids shared with `ConventionClaimID` and `CLAIM_ARITY` in `packages/codex/lib/address/convention-claims.ts`                                |
| Relational pairs                 | `pair_phenomena` in `phenomena.py`; `numeric_shape_pairs` in `report.py`                                                                                       |
| Contrast board                   | `packages/mailwoman/tools/eval-harness/gauntlet/cases/{in,cn,ru,pk}/contrast.jsonl`, checked by `cases/contrast.test.ts`                                       |
| Exposure curve                   | `configs/v4.15.0-ru-exposure-d*-2k.yaml`; `exposure/grade.py`, `exposure/curve.py`; `curve-ru.json`                                                            |
| Release-time check               | `exposure/release_check.py` and `exposure/floors.json`                                                                                                         |
| Effective-training provenance    | `packages/corpus/lib/source-register/effective-manifest.ts`, schema version 2                                                                                  |
