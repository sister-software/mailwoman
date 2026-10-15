---
title: "The production parse priors on the promotion battery and the runtime pipeline — graded on the shipped model"
description: The gazetteer FST, the street-morphology prior and the venue-head lexicon loaded through one shared loader and run on the promotion battery's legs and on the runtime pipeline, with the battery's floors before and after and the runtime pipeline's golden dev grade for each prior with the other off.
---

# The production parse priors on the promotion battery and the runtime pipeline — graded on the shipped model

The geocode session feeds the classifier three decode-time priors: the gazetteer FST beside the
weights, the street-morphology matcher with the numbered-segment prior of #2571, and the venue-head
lexicon of #2511. The promotion battery graded the classifier without any of them, and the runtime
pipeline behind the Fastify plugin and the release smoke ran the FST with the zeroed morphology
weights and no venue-head lexicon. This record grades the shared loader `loadParsePriors` in
`packages/mailwoman/lib/geocode/parse-priors.ts` on both paths (#2573).

## Inputs

| input   | value                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Weights | The shipped en-US package 10.3.0, model card 10.1.0, `model.onnx` md5 `0f7de7042a1a888d6cbc201c768e9f00`, staged package-shaped at `/tmp/lab/mailwoman/mailwoman-pair-check-mw6MjF`, int8 on both arms |
| Battery | `mailwoman eval promote --check v9.0.0-base`, before and after the change, from the compiled tree of each arm                                                                                          |
| Golden  | `data/eval/golden/v0.1.3/dev`, 4,255 rows (US 2,707, CA 4, FR 1,544), parsed through `createRuntimePipeline` with `poiQueryKind: "none"`, the en-US weights and the locale hint of the row's country   |
| Grade   | Component truth row by row with a scratch script. A row is exact when every tag agrees. A changed row moves toward the truth when fewer tags disagree and away when more do                            |
| Date    | 2026-10-15, git head 7657225b3 with the branch `feat/2573-priors-on-every-parse-path` uncommitted                                                                                                      |

## The battery before and after

The battery's per-locale, affix, unit, country, PO box, intersection and de-order legs now load the
priors through `productionPriorOptions` in `packages/mailwoman/tools/eval-harness/production-priors.ts`,
under the geocode session's default switches: the gazetteer prior on, the street-morphology prior on and
the venue-head prior on, with the venue-head lexicon of the row's country. The before arm is the battery
as it ran until this change, with the classifier and none of the three priors.

| floor                     | floor | before | after |
| ------------------------- | ----: | -----: | ----: |
| `us.postcode`             |  93.7 |   96.1 |  96.1 |
| `us.country_homograph_f1` |  64.8 |   89.8 |  92.0 |
| `us.micro`                |  82.9 |   86.8 |  86.7 |
| `us.locality`             |  79.6 |   86.4 |  86.9 |
| `us.region`               |  89.4 |   88.9 |  89.8 |
| `us.street`               |  67.7 |   77.4 |  77.9 |
| `us.street_prefix`        |  57.0 |   98.0 |  98.0 |
| `us.street_suffix`        |  69.9 |  100.0 | 100.0 |
| `us.unit_real`            |  73.0 |   98.5 |  97.0 |
| `fr.postcode`             |  98.8 |   99.5 |  99.5 |
| `fr.house_number`         |  96.6 |   99.1 |  99.1 |
| `fr.region`               |  36.7 |   37.4 |  37.4 |
| `de.native_locality`      |  89.5 |   91.6 |  91.5 |
| `arena.perturb`           |  59.9 |   63.0 |  63.0 |
| `us.po_box_real`          |  94.3 |   96.9 |  96.9 |
| `fr.cedex_real`           |  92.4 |   98.8 |  98.8 |
| `us.intersection_real`    |  80.7 |  100.0 | 100.0 |
| `fr.bare_street_intact`   |  75.0 |  100.0 | 100.0 |

The before arm reads `FAIL`: the shipped model with none of the priors fed sits under the `us.region`
floor by 0.5 points. The after arm reads `PASS` on all 18 floors. The gazetteer FST is the largest of
the three priors on this leg, and the battery had never fed it. Two floors move down inside their
margins, `us.unit_real` by 1.5 points on 34 rows and `de.native_locality` by 0.1.

## The runtime pipeline on the golden dev split, one prior at a time

The runtime pipeline now takes `streetMorphologyPrior`, on by default, and a `venueHead` stage that
reads the bundled table for the detected locale's country when set to `"auto"`. Each prior was graded
with the other off, against the pipeline before the change, on the same 4,255 rows.

| arm                                     | changed | toward truth | away from truth | exact rows |
| --------------------------------------- | ------: | -----------: | --------------: | ---------: |
| before                                  |         |              |                 |      2,523 |
| street-morphology prior, venue-head off |       7 |            4 |               1 |      2,525 |
| venue-head prior, street-morphology off |     366 |           19 |              57 |      2,495 |
| both                                    |     371 |           23 |              58 |      2,497 |

Every changed row of the street-morphology arm is US, and the one row that moves away is
`Donna Hager, 2307 Twin Oaks, Orange, TX 77630`, the same row the #2571 record lists. The four
Rockefeller Plaza board rows parse as street plus suffix on the pipeline after the change, where before
it they parsed `Rockefeller Plaza` as a venue, and the control `Rockefeller Center, 45 Rockefeller Plaza,
New York, NY 10111` keeps its venue.

The venue-head arm reads a trailing directional or street type on a bare street as a venue head.
`6th St SW, ND` becomes street `6th St` with venue `SW`, `Mountain School Rd, VT` becomes venue
`Mountain School Rd`, `123 Main St Bldg C Ste 200, Portland, OR 97214` becomes street `Main` with venue
`St`, and `05488 ST ARMAND RD VT` becomes street `Armand` with venue `ST`. Of the 57 rows that move away,
every one is US. The 19 rows that move toward the truth include a landmark row,
`Nashville, Tennessee BBQ Pit, 75 Elm Ave, Atlanta, GA 30308`, and several non-Latin rows the grade counts
by fewer disagreeing tags while the parse itself stays wrong, so the count of 19 overstates the rows the
prior improves.

The geocode session reads these rows the same way. A two-arm `mwdev_compare` on 12 of them with
`venue_head_prior` off against on (run `27d8b991-890a-4337-9f32-f6a7891b8dc1`) differs on 11, and
`500 W 7th St Ste 1100, Cincinnati, OH 45203-1234` falls from the address-point tier to the admin tier
because the street loses its suffix. The venue-head prior ships on by default in the session since
#2511, graded on the regression board. The golden dev split had not been graded against it, because the
battery did not feed it.

## Decision

The runtime pipeline runs the street-morphology prior by default and keeps the venue-head stage
opt-in, so the API and the release smoke parse the Rockefeller rows as streets and keep the 57 bare-street
rows as they are. The
geocode session keeps both priors on, as shipped. The battery legs run the session's defaults, so the
floors above are the first readings of the parse the session ships. The venue-head prior's bare-street
cost is filed as its own issue, with the rows above as its board. A fix there is graded on both the
board and this split before the pipeline's default moves.
