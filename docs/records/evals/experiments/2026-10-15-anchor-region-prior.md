---
title: "The anchor-region prior — the postcode the anchor channel fired on confirms the state name beside it"
description: What the shipped postcode anchor and the data root hold for a US ZIP, why a 3-logit region boost alone cannot move the space-separated rows, the rule that confirms a region name from the postcode-prefix index's ancestry while suppressing a locality reading the gazetteer holds no evidence for, and the grades on the golden dev split, the board and the battery.
---

# The anchor-region prior — the postcode the anchor channel fired on confirms the state name beside it

The #2581 record left the space-separated forms of five golden dev rows reading the state as a
locality: `05448 New St Vermont`, `05478 Point Rd Vermont`, `82801 Cresent Pl Wyoming`, `05851 Lily
Pond Rd Vermont` and `82637 N Seventh St Wyoming`. The comma form had been decided by the gazetteer
FST's 2.00-logit region bias against a 1.5-logit model margin, and the space form's margin is wider
than any bias the FST's cap allows. This record measures what the runtime holds for those postcodes,
builds a prior that reads it (#2582), and grades it.

## Inputs

| input   | value                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Weights | The shipped en-US package 10.3.0 with the rebuilt street-morphology FST of #2580                                        |
| Anchor  | The package's `postcode-us.bin`, 42,317 keys, each a country posterior and a centroid                                   |
| Index   | The data root's `postcode-prefix/postcode-prefix-us-2026-08-22.bin`, a PFX1 index of 915 three-digit prefixes           |
| Golden  | `data/eval/golden/v0.1.3/dev`, 4,255 rows, through `createRuntimePipeline` with its defaults, against main at f7984ab8a |
| Board   | The 1,277-row regression board through two worktree arms, main f7984ab8a against the branch                             |
| Battery | `mailwoman eval promote --check v9.0.0-base` on the `/tmp/lab/mailwoman/fst-new` cache, against the same cache on main  |
| Date    | 2026-10-15                                                                                                              |

## What the runtime holds for a ZIP

The anchor channel feeds the model one vector per anchored piece: the country posterior over the
locale set and the centroid as `lat/90` and `lon/180`. For `05448` that vector is `US: 1` and the
point 44.754,-72.897. The model holds no region name to match `Vermont` against.

The data root holds the region in two places. `postalcode-us.db` holds every one of the five ZIPs with
a `parent_id` into the admin gazetteer, and the parent's ancestry reaches the region in every case:
localadmin Fairfield, locality St. Albans and localadmin Wheelock under Vermont, county Sheridan and
county Converse under Wyoming. The PFX1 index that `mailwoman gazetteer postcode-prefix` builds holds
the region by point-in-polygon under a unanimity rule: 876 of its 915 three-digit prefixes assert a
region, covering 40,871 of 42,313 units, and a prefix whose units sit in two regions asserts none.
`054` and `058` assert Vermont, `828` and `826` Wyoming, `100` New York, and `205`, the District of
Columbia's, asserts no region. The session loaded neither source before this change.

A region's bounding box is no substitute: New York's box covers every Vermont point above and
Montana's covers Sheridan County. The issue's distance leg, every region within reach of the point,
needs the polygon pass the index builder already runs, and stays open.

## Why a boost alone is not enough

On `05448 New St Vermont` the model's logits on `Vermont` read `B-locality` 6.92 against `B-region`
1.20, a margin of 5.72. The street-context check scales the FST's locality bias to zero beside `St`,
so the first version of the prior, which raised the anchored region to the FST's 3-logit cap, left
the row at 6.92 against 4.20. On `05851 Lily Pond Rd Vermont` the same version left `B-street` 5.23
against `B-region` 4.20, because the one-word street suppression is 0.375 logits. One of the five rows,
`82801 Cresent Pl Wyoming`, flipped under that version.

## The rule

The prior runs inside the gazetteer FST prior. The classifier reads the postcode spans the anchor
channel fired on, through the same enumerator the channel paints with, and asks the loaded
postcode-prefix indexes for each postcode's ancestry in its posterior's one country. At an FST match
whose region entry is one of those ancestors and whose gazetteer name is the written surface:

- the region labels take the full `maxBias` of 3 logits, outside the referential and the
  street-context scale;
- the street labels take the full suppression of 1.5 logits rather than the one-word scale;
- the locality labels are suppressed by 3 logits, unless a locality of the written name with a
  nonzero referential lies inside the region, as `New York` does in New York.

The name test keeps an alias out: the FST reaches the District of Columbia under `washington`, and
the prior gives it no boost. The locality test asks for positive evidence: under `wyoming` the FST
holds an alias row for Albany and a locality named Wyoming with a referential of 0 inside Wyoming,
and neither keeps the locality reading of `82637 N Seventh St Wyoming`.

## Traced rows

| input                                            | before                              | after                                                |
| ------------------------------------------------ | ----------------------------------- | ---------------------------------------------------- |
| `05448 New St Vermont`                           | locality Vermont, resolved to IL    | region Vermont, resolved to the postcode             |
| `05478 Point Rd Vermont`                         | locality Vermont                    | region Vermont, resolved to the postcode             |
| `82801 Cresent Pl Wyoming`                       | locality Wyoming                    | region Wyoming, resolved to the postcode             |
| `05851 Lily Pond Rd Vermont`                     | street Vermont                      | region Vermont, resolved to the postcode             |
| `82637 N Seventh St Wyoming`                     | locality Wyoming, resolved to MI    | region Wyoming, resolved to the postcode             |
| `1600 Pennsylvania Ave NW, Washington, DC 20500` | locality Washington, region DC      | unchanged, the prior silent on prefix 205            |
| `123 Main St, New York, NY 10001`                | locality New York, region NY        | unchanged, the in-region locality keeps its reading  |
| `Seattle, Washington 98101`                      | locality Seattle, region Washington | unchanged                                            |
| `49509 Wyoming Michigan`                         | locality Wyoming, region Michigan   | unchanged                                            |
| `123 Main St Vermont`                            | locality Vermont                    | unchanged because the parse has no anchored postcode |

## Grades

| measure                             |  main | branch |
| ----------------------------------- | ----: | -----: |
| golden dev rows changed, of 4,255   |       |     46 |
| golden dev rows toward the truth    |       |     46 |
| golden dev rows away from the truth |       |      0 |
| golden dev exact rows               | 2,542 |  2,559 |

Every changed row is a US row of the shape street, state name, ZIP in some order: `Shadow Ridge
Lane, Wyoming 82901`, `North Dakota 58845, 1st Ave E`, `05676 Vermont, Railroad St`. FR reads zero
changes, as no index covers France.

The board reads 0 of 1,277 rows changed at any threshold and no tier change (run
`777fb8bb-2621-48d0-b1fc-c945aff86b3d`), 459 of 756 rows within 1 km on both arms. The GB rows
read the same with the `gb-esw` and `gb-ni` indexes loaded, and FR and DE have no index.

The `v9.0.0-base` battery reads `PASS` on all 18 floors on main and on the branch. Three US floors
move: `us.micro` from 87.3 to 87.6, `us.locality` from 86.8 to 87.9 and `us.region` from 89.7 to
90.1. The other 15 floors read the same to the tenth.

## Cost

The three PFX1 indexes under the data root load in 13 ms once per classifier. The probe,
from the anchored spans to the region id set, takes 5.2 µs per parse, measured over 120,000 calls
on the six traced inputs. A parse of one of the five rows takes about 10 ms, so the prior adds
under a thousandth of it.

## What stays open

The prior reads the data root's indexes, so the browser runtime, which loads only package artifacts,
parses without it. The next step for the demo is to ship the index in the weights package. The
distance leg of #2582 stays open.

The resolver's `postcodeContainmentCoherence` check does not reach these rows. On main with the
check on, the six inputs above resolve the same as with it off, 0 of 6 changed (run
`84a02700-a94a-4562-b774-dddd80c1868b`): the parse reads the state as a locality, the resolver picks
the locality of that name in Illinois, and the postcode under it records a `region_scope_miss`
without moving the answer. The parse-side prior is what closes the five rows.

## Decision

The anchor-region prior ships on by default under the `gazetteerPrior` switch, as a confirmation
step of the FST prior. It moves 46 golden dev rows toward the truth and none away, changes no board
row, and raises three US battery floors.
