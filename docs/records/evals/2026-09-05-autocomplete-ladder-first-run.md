# The autocomplete ladder, first run (#2154)

**Date:** 2026-09-05 · **Tree:** the working tree at fa9a21d95 plus the ladder itself · **Weights:** the installed `@mailwoman/neural-weights-*` packages (9.1.0 base) · **Command:** `mailwoman eval autocomplete --country <CC> --limit 40` · **Arms:** `parse_resolve` (what `@mailwoman/photon`'s `/api` runs on a prefix today, one coordinate) and `fst` (the FST autocomplete tier, top-5 suggestions, coordinates from `admin-global-priority.db`). Every rung ran under the row's country as the locale hint. Report-only.

## Headline rows and what each arm did

| Country | Rows (headline / read / excluded, no truth) | Arm             | Rows hit at some rung | Median first-hit, fraction of characters | Churn rows | Short rungs (1–2 chars) that answered | Full-string hits |
| ------- | ------------------------------------------- | --------------- | --------------------: | ---------------------------------------: | ---------: | ------------------------------------: | ---------------: |
| GB      | 40 / 40 / 82                                | `parse_resolve` |              36 of 40 |                                      80% |          3 |                              24 of 78 |         35 of 40 |
| GB      | 40 / 40 / 82                                | `fst`           |               6 of 40 |                                      22% |          4 |                              59 of 78 |          2 of 40 |
| FR      | 35 / 40 / 17                                | `parse_resolve` |              31 of 35 |                                      82% |          4 |                              24 of 66 |         30 of 35 |
| FR      | 35 / 40 / 17                                | `fst`           |               7 of 35 |                                      20% |          3 |                              61 of 66 |          4 of 35 |
| US      | 35 / 40 / 37                                | `parse_resolve` |              26 of 35 |                                      91% |          2 |                              48 of 69 |         26 of 35 |
| US      | 35 / 40 / 37                                | `fst`           |               4 of 35 |                                      18% |          4 |                              65 of 69 |          0 of 35 |

Reading the two arms: the FST tier is a PLACE autocomplete. It holds localities and neighbourhoods, so a rooftop row with a 100 m tolerance cannot be hit by any suggestion, and its hits are the bare-toponym rows (`Whitby` at 6 characters, `Londonderry` at 2, `Newport, Wales` at 2). It answers on almost every one- and two-character rung, which is what a suggestion menu does and what the parse → resolve path mostly does not. Parse → resolve reaches the truth on most rows only near the end of the string — median 80–91% of the characters typed — because a partial address parses as something else until the locality arrives.

## Latency per rung length, ms (p50 / p95)

| Country | Arm             | 1–2 chars |     3–5 |     6–12 |        13+ |
| ------- | --------------- | --------: | ------: | -------: | ---------: |
| GB      | `parse_resolve` |   12 / 19 | 13 / 68 | 38 / 427 |  38 / 1976 |
| GB      | `fst`           |    5 / 12 |   4 / 6 |    0 / 5 |      0 / 0 |
| FR      | `parse_resolve` |   11 / 15 | 12 / 75 | 12 / 412 | 359 / 2281 |
| FR      | `fst`           |   14 / 27 | 12 / 15 |   0 / 13 |      0 / 0 |
| US      | `parse_resolve` |   11 / 16 | 11 / 41 | 16 / 203 |  18 / 1632 |
| US      | `fst`           |   14 / 24 | 11 / 18 |   0 / 15 |      0 / 0 |

The p95 at 13+ characters on the parse → resolve arm is 1.6–2.3 s in every country. The slowest rungs are the venue-led rows: `Moms Nothing Fancy Seafood Restaurant and more...` 5,335 ms, `Hartford HealthCare Center for Healthy Aging, 462 …` 3,385 ms (US); `Bread Street Kitchen & Bar – The City, 14 South Pl…` 2,827 ms, `% ARABICA London Covent Garden, 5 King St, London` 2,733 ms (GB). A type-ahead front cannot run that path per keystroke on those inputs; this is the number the FST-tier decision in #2154 has to beat or route around.

## Rows the parse → resolve arm never reached, at any rung

- **GB** (4): `gb-fork-entity-savile-row-guard` (improvement_target), `gb-interesting-mischicks` (improvement_target), `gb-interesting-st-andrews-lakes` (improvement_target), `gb-op4-leptis-magna-ruins` (improvement_target)
- **FR** (4): `fr-lyonnais-3-bare-country-bias` (improvement_target), `fr-lyonnais-3-bare-no-context` (improvement_target), `fr-op3-halle-o-lognes` (improvement_target), `fr-op3-les-halles-75001` (improvement_target)
- **US** (9): `us-addison-zip-75001` (pass), `us-cat-statue-of-liberty` (improvement_target), `us-op3-clown-motel-tonopah` (improvement_target), `us-op3-evergreen-cemetery-kalkaska` (improvement_target), `us-op3-four-corners-monument` (improvement_target), `us-op4-food-city` (improvement_target), `us-op4-hartford-healthcare-center-for-healthy-aging` (improvement_target), `us-op4-odnr-aquatic-visitors-center-avc` (improvement_target), `us-op4-queen-st` (improvement_target)

Every one of these is `improvement_target` except **`us-addison-zip-75001`** (`4900 Airport Pkwy, Addison TX 75001`, status `pass`, expects `address_point` within 100 m). The full-string rung answered 32.966059, −96.829856 at the `interpolated` tier, 198 m from the truth; `mwdev_run` over the US `pass` rows on the same tree answers the same coordinate and tier. The ladder's full-string rung equals the board grade here, as the rule requires — and the board grade is a failing `pass` row on this data root.

## Harness notes

- The first FR run read the US FST for French rows, because the FST arm followed the weights-overlay routing (`OVERLAY_LOCALE_BY_COUNTRY` has no FR) and reported `Paris` as never reached; fixed before this receipt (`FST_LOCALE_BY_COUNTRY`), and a country with no FST is now counted out of the arm's denominator instead of graded as a miss.
- Excluded rows carry no truth coordinate (GB 82 of 122 read, FR 17, US 37); the ladder authors no truth.
- Rows with a tolerance above 25 km are read but kept out of every summary (FR 5, US 5, GB 0).
- `mwdev_compare` does not yet accept a ladder input; the per-country JSON reports are in the session scratchpad and the next run should land beside this file.

https://claude.ai/code/session_019mAe7AK8EQYwGmnJcctW2N
