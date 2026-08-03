# Anchor → resolver score-delta harness — openaddresses-us-sample.jsonl

Offline early-signal for the DEFERRED postcode-anchor resolver re-ranker (task #59, #240). For each row we query the locality lookup with no country (the honest multi-locale baseline), then soft re-rank the candidates by the postcode anchor's country posterior, and log what changes. The shipped resolver is untouched.

- anchor weight: 2 · candidates/query: 10 · rows: 2000
- eligible (locality + candidates + anchor): **1964** (skipped: 9 no-locality, 25 no-candidate, 2 no-anchor)

| metric                                             | value                               |
| -------------------------------------------------- | ----------------------------------- |
| anchor changed the top-1 pick                      | 17.4% (342/1964)                    |
| of those, wrong-country → anchor-country corrected | 38                                  |
| gold locality match — anchor-OFF                   | 98.9% (1943/1964)                   |
| gold locality match — anchor-ON                    | 98.9% (1943/1964)                   |
| **net gold-match delta (name)**                    | **+0.0%** (0 improved, 0 regressed) |
| mean score margin the new winner overcame          | -0.074                              |
| median coord error — anchor-OFF                    | 18.5 km                             |
| median coord error — anchor-ON                     | 17.1 km                             |
| coord error improved >100 km / worsened >100 km    | 333 / 7 (of 1964 placed)            |

## Read

The name-surface gold-match metric is blind to country confusion — a US "Berlin" name-matches the German gold "Berlin" while sitting an ocean away. Coordinate error to the OA gold point is the non-gameable signal, so weigh the coord deltas over the name deltas here.

Feeding the anchor's country posterior corrects 38 wrong-country picks and pulls 333 rows >100 km closer to the gold point (median 18.5 km → 17.1 km, 943894 km saved total). That value is invisible to name-match (+0.0%) — exactly the artifact the coordinate-first resolver direction flagged. The re-ranker is worth prototyping; the mean margin (-0.074) is the score gap a soft boost must clear.
