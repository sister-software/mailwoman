---
title: "The FST prior's street-context check kept inside the segment — the state after a comma keeps its region bias"
description: Why five golden dev rows of the shape postcode, street, state name read the state as a locality once the morphology FST held the two-letter street types, the measured logits and biases on one of them, the segment rule that closes it, and the grade on the board, the golden dev split and the battery, with the space-separated forms measured beside the comma forms.
---

# The FST prior's street-context check kept inside the segment — the state after a comma keeps its region bias

The #2579 record left five golden dev rows that moved from `region` to `locality` on the state name:
`05448 New St, Vermont`, `05478 Point Rd, Vermont`, `82801 Cresent Pl, Wyoming`, `05851 Lily Pond Rd,
Vermont` and `82637 N Seventh St, Wyoming`. This record measures the state name's logits and priors on
the first two, finds the reader that moved them, bounds it, and grades the bound (#2581).

## Inputs

| input   | value                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Weights | The shipped en-US package 10.3.0 with the rebuilt street-morphology FST of #2580, md5 `0f7de7042a1a888d6cbc201c768e9f00`       |
| Traces  | `mwdev_trace` with the full matrices on the two rows, through the geocode session with every default on                        |
| Golden  | `data/eval/golden/v0.1.3/dev`, 4,255 rows, through `createRuntimePipeline` with its defaults, against main at db0179005        |
| Board   | The 1,277-row regression board through two worktree arms, main db0179005 against the branch, both reading the rebuilt artifact |
| Battery | `mailwoman eval promote --check v9.0.0-base` on the `/tmp/lab/mailwoman/fst-new` cache, against the same cache on main         |
| Date    | 2026-10-15                                                                                                                     |

## The measurement

On `05448 New St, Vermont` the model's logits on the piece `Vermont` read `B-locality` 5.16 against
`B-region` 3.68, a locality margin of 1.48. The gazetteer FST holds `Vermont` as the region at
referential 0.667, as a locality in Illinois at 0.046 and as a localadmin at 0.064, and the prior's
bias is the referential times the max bias of 3: 2.00 logits toward `B-region` against 0.19 toward
`B-locality`. With the prior applied the state reads as a region, 5.68 against 5.35. On `05478 Point
Rd, Vermont` the logits read 4.72 against 3.22, a margin of 1.50, and the same bias gives 5.22 against
4.91.

The trace reports the FST prior as applied on no cell of either row. `streetContextScale` reads the
word group before the match, skips the comma group because its token is empty, finds `St` or `Rd`,
now a street type, and multiplies the match's positive bias by the pipeline's
`STREET_CONTEXT_POSITIVE_SCALE` of 0. The old artifact held neither abbreviation, so the scale stayed
at 1 and the region bias stood. The street-morphology prior is ruled out: the five rows read the same
with it off and on (run `3d4b9f88-9c6d-4e22-ad1c-1692bc660979`).

The anchor channel fires on the postcode in both rows, and what it feeds is the postcode's country
posterior and its centroid as `lat/90` and `lon/180`. It does not feed the region that contains the
postcode, so the model holds a coordinate for `05448` and no name to match `Vermont` against. The
resolver then reads the locality `Vermont` in Illinois, and the postcode under that parent records a
`region_scope_miss` check, with `postcodeContainmentCoherence` off by default. Both are open designs:
a region prior from the postcode anchor's Who's On First ancestry on the parse side, and the
containment check on the resolve side.

## The space form

Users write a space where these rows write a comma. `05448 New St Vermont` and the other four read
the state as a locality on both artifacts and on main and the branch alike, at confidence 0.95 for
`New St`, 0.53 for `Point Rd`, 0.55 for `Cresent Pl` and 0.88 for `N Seventh St`, and `05851 Lily Pond
Rd Vermont` reads `Vermont` as a street at 0.74. With a house number in place of the postcode, `123 New
St, Vermont` and three of the other four read the state as a locality at 0.85 to 0.94. So the comma is
the factor on these five: with it the model's margin is 1.5 logits and the 2.00 region bias decides,
and without it the margin exceeds the bias. The space form is a parse-side gap that only a stronger
signal closes, and the postcode's ancestry is that signal.

## The bound

A street type's adjacency now stays inside the match's comma-separated segment, so the type that ends
`05448 New St` leaves the bias of the name after the comma whole, while `Washington` in `Washington
Blvd` still scales down beside the type in its own segment. A house number's adjacency still crosses
the comma: the first version of the bound kept it inside the segment too, and the board read
`Terraza 38, Sofia Camarena 38, Loma Blanca, 45100 Zapopan, Jal., Mexico` resolving `Loma Blanca` as the
locality of that name in Chihuahua, 1,242 km from the truth, because a number-after-street line writes
the colonia after the comma and the scaled bias is what keeps a colonia that is also a locality
elsewhere on its dependent reading.

## Grades

| measure                             |  main | branch |
| ----------------------------------- | ----: | -----: |
| golden dev rows changed, of 4,255   |       |      9 |
| golden dev rows toward the truth    |       |      6 |
| golden dev rows away from the truth |       |      0 |
| golden dev exact rows               | 2,537 |  2,542 |

The six rows toward the truth are the five above and `Guilford Centre, Vermont, US`. FR reads zero
changes.

The first version of the bound, with both adjacencies inside the segment, read 1 of 1,277 board rows
regressed, the Zapopan row above (run `83e7c1f2-16d3-4499-9fb3-631700dbfb37`). The shipped version,
with the house number's adjacency crossing the comma, reads 0 of 1,277 rows changed at any threshold
and no tier change (run `ddbbac12-1cc5-48d1-b6a5-9427f309a094`), 459 of 756 rows within 1 km on both
arms. FR, GB and DE rows are unchanged. The five rows resolve through the session to their postcodes
in Vermont and Wyoming, where main resolves them to the locality Vermont in Illinois.

The `v9.0.0-base` battery reads `PASS` on all 18 floors on main and on the branch, with `us.locality`
from 86.7 to 86.8 and `us.region` from 89.6 to 89.7, and the other 16 floors the same to the tenth.

## Decision

The segment rule ships on the street-type adjacency, with the house-number adjacency as it was. It
moves 6 golden dev rows toward the truth and none away, changes no board row, and passes the battery.
The space-separated forms of the five rows stay as they are on this branch: the model reads the
state as a locality there with a margin the 2.00-logit region bias cannot cover, so that shape waits
on a prior that feeds the postcode's Who's On First ancestry to the parse, filed as its own issue.
