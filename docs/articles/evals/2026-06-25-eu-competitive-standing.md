---
title: EU competitive standing — same-harness, v4.15.0 + the -20j gazetteer
date: 2026-06-25
---

# EU+AU competitive standing (#219)

The 06-23 benchmark put mailwoman ~20pp behind Nominatim on EU @25km, and a
cross-harness estimate later put us at ~−4pp. Both compared across different
harnesses. This is the **same-harness** run the night plan asked for: identical
held-out OpenAddresses rows (real government lat/lon), 40 rows/locale, every
system graded through the same scorer. mailwoman runs v4.15.0 on the `-20j`
candidate gazetteer (the demo's byte-range backend, with the PT/PL/CZ/AU/AT
postcodes the #370 gate needs).

## Resolve-rate @ 25 km (right-locality-area — the headline)

| locale | mailwoman | mailwoman+rescore | nominatim |
|---|--:|--:|--:|
| IT | 100% | 100% | 73% |
| PT | 83% | 83% | 45% |
| PL | 88% | 90% | 98% |
| AT | 70% | 73% | 98% |
| CZ | 90% | 95% | 85% |
| FR | 95% | 95% | 63% |
| AU | 75% | 75% | 100% |
| **ALL** | **86%** | **87%** | **80%** |

## Two-axis aggregate

| system | n | @1km | @5km | @25km | cond. p50 (km) | no-result |
|---|--:|--:|--:|--:|--:|--:|
| mailwoman | 280 | 28% | 69% | 86% | 2.1 | 4% |
| mailwoman+rescore | 280 | 29% | 70% | 87% | 2.1 | 3% |
| nominatim | 280 | 75% | 79% | 80% | 0.0 | 17% |

## What it says

**mailwoman+rescore beats Nominatim on the EU+AU aggregate, 87 vs 80 @25km.**
The cross-harness estimate had us trailing ~−4pp; the same-harness truth is +7pp
ahead. The earlier number was a harness artifact.

The per-locale split is the positioning story, not noise. mailwoman wins broad
and large where OSM street addresses are sparse — IT (100 vs 73), PT (83 vs 45),
FR (95 vs 63), CZ (95 vs 85). Nominatim wins the dense-OSM locales — PL (98 vs
90), AT (98 vs 73), AU (100 vs 75). A geocoder built on a parser + a gazetteer
degrades gracefully on the locales OSM hasn't filled; a search index over OSM
data inherits OSM's coverage gaps.

The recall axis is the differentiator. Nominatim is sharper when it answers
(75% @1km vs mailwoman's 28% — it returns rooftop points, we return admin
centroids at p50 2.1km), but it **abstains on 17% of inputs** where mailwoman
misses only 3-4%. mailwoman answers nearly always, at coarser precision, and —
with the isotonic-calibrated per-field confidence — can tell you when to trust
the answer. That is the slice a calibrated parser should own.

## The #370 rescore lever

Isolated on the `-20j` gazetteer (both arms same backend), the span-rescore
lever is **+1pp aggregate @25km (86→87), zero regressions**: CZ +5, AT +3,
PL +2; IT/PT/FR/AU flat; no-result 4→3%. The end-to-end `span-rescore-e2e`
run agrees: +1.1pp over n=972, CZ +6. The `-20j` *data* did the heavy lifting
(the 59→86 climb); rescore adds the last point. It passes the night-plan gate
(newly-reachable locales improve, IT non-regressed, no losers) — a clean
default-on candidate, pending the call to flip it.

## Artifacts

- `scripts/eval/competitive-benchmark.ts --candidate-db candidate-global-20j.db --span-rescore` → `/tmp/bench-full-20j.md`
- `scripts/eval/span-rescore-e2e.ts --candidate-db candidate-global-20j.db` (n=972)
- `-20j` gazetteer live at R2 `mailwoman/gazetteer/2026-06-24a/candidate.db`; priors recoverable.
