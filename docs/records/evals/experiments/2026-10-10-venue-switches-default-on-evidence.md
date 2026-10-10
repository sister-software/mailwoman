---
title: "Venue switches default-on — the venue-head prior and the anchor-free venue tier on the regression board"
description: The board evidence behind turning the venue-head prior and the POI venue tier on by default for every locale, with per-arm attribution and the rebuilt head table.
---

# Venue switches default-on — the venue-head prior and the anchor-free venue tier on the regression board

This record carries the evidence for turning two #2511 switches on by default for every locale:
`venueHeadPrior` (the venue-head emission prior, bias scale 1) and `poiVenueTier` (the anchor-free venue
lookup in the POI tier). The D-rule asks that a default-on change regress no tier-1 locale against the
shipped model; the arms below measure every country on the board, not the tier-1 locales alone.

## Inputs

| input      | value                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board      | `mailwoman eval gauntlet --layer regression`, 609 counted rows plus tracked rows, `regression.db` rebuilt from the committed cases (stamp `1fc9dad1…`)                                                                                                                      |
| Model      | The shipped 10.1.0 graph (`v7.2.0-address-systems` step 60,000) on every arm; only the two switches and the head table vary                                                                                                                                                 |
| Head table | `packages/poi-taxonomy/data/venue-heads.json`: the shipped table, then the rebuild with the stem floor, the any-position place comparison, single-letter refusal and the every-language admin exclusion (52,284 country entries over 76 countries, 158 language aggregates) |
| Baseline   | Production pins before the arc: 569 of 609 pass, 40 failures that predate the arc                                                                                                                                                                                           |
| Date       | 2026-10-10                                                                                                                                                                                                                                                                  |

## Arms

| arm                                                   | pass / 609 | new failures vs baseline | fixed | tracked promotions |
| ----------------------------------------------------- | ---------: | -----------------------: | ----: | -----------------: |
| baseline, production pins before the arc              |        569 |                        0 |     0 |                198 |
| `--poi-venue-tier on` alone                           |        569 |                        0 |     0 |                201 |
| shipped table, `--venue-head-prior on`, scale 1       |        568 |                        2 |     1 |                199 |
| shipped table, both on, scale 1.5                     |        563 |                        7 |     1 |                202 |
| shipped table, both on, scale 2                       |        551 |                       19 |     1 |                204 |
| rebuilt table, `--venue-head-prior on`, scale 1       |        570 |                        0 |     1 |                198 |
| rebuilt table, both on, scale 1                       |        570 |                        0 |     1 |                201 |
| rebuilt table, both on, scale 1.5                     |        570 |                        0 |     1 |                200 |
| rebuilt table, production pins after the default flip |        570 |                        0 |     1 |                201 |

The fixed row on every prior arm is `in-contrast-block-premise-subdivision` (IN). The venue tier alone changes
no counted row and promotes `ca-op3-swiss-chalet-gander`, `us-op3-four-corners-monument` and `us-op4-the-903`
from tracked to passing. The last arm is the committed state: `GEOCODE_SESSION_DEFAULTS.venueHeadPrior` and
`GEOCODE_SWITCH_DEFAULTS.poiVenueTier` both `true`, no pin, and it reproduces the both-on arm row for row.

## What the shipped table's failures were

The two failures under the shipped table at scale 1 were `br-brasilia-shis-eql-6-8-modulo-c` and
`gb-lex-boulevard-london-regent-park` (venue `Boulevard London, Regent Park` ≠ `Boulevard London`). At
scale 1.5 and 2 it added `bare-country-au`, `bare-country-de-endonym`, `us-dc-pennsylvania` (region null),
`gb-lex-high-street-cafe` (locality `Walton`) and AU PO Box rows. Each traced to a table entry: GB suffix
`ondon` 2.65 from `london` alone, AU `australia` 3.87 and `nsw` 3.03, DE `deutschland` 4.62, US `dc` 3.66,
GB first `on` 2.74 and `the` 1.43. The rebuilt table admits none of them, and the every-language exclusion
removes 1,117 more entries such as `bayern`, `herts`, `cymru` and `kernow` with no board row moving.

## Scale

Bias scale 1 is the default. Scale 1.5 holds the same counted rows and loses one tracked row,
`us-op3-island-lake-duplicate-degenerate`; scale 2 under the shipped table lost 19 counted rows.

## Coverage

The table answers 243 of the 247 country codes in the Overture names file, 76 through their own entries
and the rest through a language aggregate. The four without an answer are `XG`, `XS`, `XW` and `XZ`, Overture
codes that are not countries. A word without an entry gives the prior no information, so a country without
an answer keeps the model's own decision.

## Defect found while measuring

The geocode core merged the switch defaults into `switches` but handed the raw `deps` to `applyEntityTiers`,
so a caller that left `poiVenueTier` unset got the tier off while a session got the default. The first board
run after the default flip showed 198 promotions instead of 201 for that reason. The core now passes the merged
switch, and the last arm above is the run after that fix.
