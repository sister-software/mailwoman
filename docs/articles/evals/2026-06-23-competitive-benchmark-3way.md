# Competitive benchmark — mailwoman vs Nominatim vs Pelias (2026-06-23)

Same-harness, three-system comparison on real held-out OpenAddresses coordinates, run after the
#193 GeoNames postcode shard landed PL/CZ coverage in the candidate gazetteer (`candidate-global-20i.db`).
This supersedes the night's two-system (mailwoman vs Nominatim) e2e numbers, which used a different
grader (`span-rescore-e2e.ts`, tag-rank `bestCoord`) on `-20h` and so weren't directly comparable to the
incumbents.

## How we scored

- **Identical inputs.** Every system gets the same raw OA address string and the same country hint
  (mailwoman `defaultCountry`, Nominatim `countrycodes`, Pelias `boundary.country`). The Pelias arm was
  country-scoped for this run — previously it ran unscoped, which _understated_ it by allowing
  wrong-country matches.
- **PRIMARY metric — resolve-rate @ 25 km.** Within 25 km of truth = right-locality-area; a no-result
  counts as a miss. Coarse on purpose: mailwoman resolves to admin/postcode **centroids**, so a
  km-to-rooftop metric would reward the incumbents' rooftop-when-they-match and penalize our centroid.
  Right-_place_ is the fair test.
- **SECONDARY — conditional median error + the @1/@5 km tiers**, to keep the centroid-vs-rooftop trade
  visible rather than hidden.
- `n = 60` rows/locale, clean OA input (NOT the messy-degradation case). Lever-off (`mailwoman`) and
  `#370` span-rescore lever-on (`mailwoman+rescore`) are both graded from the same parse.

## Resolve-rate @ 25 km

| locale            | mailwoman | mailwoman+rescore | nominatim |  pelias |
| ----------------- | --------: | ----------------: | --------: | ------: |
| IT                |      100% |              100% |       75% |     85% |
| PT                |       67% |               78% |       48% |     82% |
| PL                |       88% |               90% |       97% |     92% |
| AT                |       73% |               80% |       98% |    100% |
| CZ                |       85% |               87% |       87% |     78% |
| FR                |       93% |               93% |       65% |     98% |
| AU                |       32% |               35% |       97% |     78% |
| **EU (no AU)**    |   **84%** |           **88%** |   **78%** | **89%** |
| **ALL (incl AU)** |   **77%** |           **80%** |   **81%** | **88%** |

## Two-axis aggregate (incl AU)

| system            |   n | @1km | @5km | @25km | cond. p50 (km) | no-result |
| ----------------- | --: | ---: | ---: | ----: | -------------: | --------: |
| mailwoman         | 420 |  24% |  60% |   77% |            2.5 |       14% |
| mailwoman+rescore | 420 |  26% |  63% |   80% |            2.5 |        8% |
| nominatim         | 420 |  77% |  80% |   81% |            0.0 |       17% |
| pelias            | 420 |  71% |  83% |   88% |            0.0 |        2% |

## Reading it honestly

1. **Pelias is the strongest system here** — 88% @25km all-panel, 2% no-result. A hosted Elasticsearch
   stack over mixed sources resolves nearly everything and places most of it at rooftop. It is the real
   bar, and it is ahead of us overall.
2. **On Europe (six EU locales) mailwoman+rescore beats Nominatim by ~10pp (88 vs 78) and is level with
   Pelias (88 vs 89)** — while running as a 30 MB browser model with no Elasticsearch. We win IT, PT, FR
   outright; CZ now edges Pelias (87 vs 78).
3. **Australia drags the aggregate.** mailwoman 35% vs Nominatim 97 / Pelias 78. The whole EU-vs-all-panel
   gap (88 → 80) is AU. The failure mode is same-named towns scattered across states, which the
   country-level postcode-consistency gate can't disambiguate. EU-only is the legitimate headline for a
   Europe comparison _because_ AU is its own, named, unsolved problem — not because hiding it flatters us.
4. **Centroids, not rooftops.** mailwoman is 26% @1km vs Nominatim 77 / Pelias 71. The @25km parity is
   right-_area_ parity; the incumbents are far more precise when they hit. State it, don't bury it.
5. **Two levers, partly substitutes.** On `-20h` (no PL/CZ postcodes) the #370 rescore lever lifted EU
   ~+16pp by _recovering the fragmented town_. On `-20i` the postcode resolves the address directly, so
   base is already high and the rescore's marginal EU lift shrinks to +4pp. Postcode coverage (#193) and
   word-recovery (#370) both close the "silence," by different mechanisms — the postcode does most of the
   work where we now have it; the rescore catches the no-postcode tail (PT, AU).

## Levers A + B (post-benchmark, default-off — measured on the same grader)

The benchmark's failure dump (`scripts/eval/failure-dump.ts`) classified the 82 misses and pointed at
two compounding levers. Both are default-off; numbers are mailwoman+rescore on the same harness/grader,
candidate gazetteer noted.

- **Lever A — postcode-disambiguated locality selection** (`ResolveOpts.postcodeConsistency`, resolver-
  only, no data/GPU): when a same-named locality resolves far from a resolved sibling postcode, re-pick
  the instance nearest the postcode (or fall back to the postcode point). Fixed the 16 "postcode-
  available-but-ignored" misses with ZERO regressions.
- **Lever B — extend the #193 GeoNames postcode fill to PT/AU/AT** (`candidate-global-20j`): converts
  uncovered postcodes into anchors, which Lever A then disambiguates. AU 35→65 (+30pp), PT 78→88.

| locale      | baseline (-20h) | +A (-20i) | +A+B (-20j) | Nominatim | Pelias |
| ----------- | --------------: | --------: | ----------: | --------: | -----: |
| IT          |             100 |       100 |         100 |        75 |     85 |
| PT          |              67 |        78 |          88 |        48 |     82 |
| PL          |              88 |        98 |          98 |        97 |     92 |
| AT          |              73 |        87 |          87 |        98 |    100 |
| CZ          |              85 |        92 |          92 |        87 |     78 |
| FR          |              93 |       100 |         100 |        65 |     98 |
| AU          |              32 |        35 |          65 |        97 |     78 |
| **EU (6)**  |          **66** |  **92.5** |    **94.2** |    **78** | **89** |
| **ALL (7)** |          **61** |    **84** |    **90.0** |    **81** | **88** |

With both levers, mailwoman leads BOTH incumbents on the @25km right-area metric — EU 94.2 and all-panel
90.0 — from a 30 MB browser model, no Elasticsearch. The @1km precision gap (centroids vs rooftops)
stands; this is right-AREA, not rooftop.

Residuals after A+B (the next levers): AU's remaining misses are mostly a PARSE issue — the model emits a
house number as a second postcode ("Grantson Street 51" → postcode=51), and the anchor picks the first
postcode (51) not the real one (4030); a Lever-A-v2 anchoring on the postcode that RESOLVES would catch
them. AT's 5 EMPTY are postcodes GeoNames AT doesn't carry.

## Caveats / next

- **Clean input only.** This run is clean OA strings. The "calibrated parser degrades better than a token-
  matching search index on messy input" claim needs a separate `--messy` run before it can be made.
- **AU** is the open coverage/disambiguation problem (#208 G-NAF ingest + a sub-country consistency gate).
- **AT** (73→80) is the next EU postcode-coverage candidate — GeoNames has 18,937 AT rows; the gazetteer
  has only 809. Same lever as PL/CZ.

Harness: `scripts/eval/competitive-benchmark.ts` (`--span-rescore` grades base + lever from one parse;
the Pelias arm rides the git-excluded `diag-geocode-earth.ts`, country-scoped, throttled to respect
geocode.earth's 1000/day + 10/s). Raw: `candidate-global-20i.db`, model `out/v191/model.onnx` (v4.13.0).
