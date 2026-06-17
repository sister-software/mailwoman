# Per-address-type head-to-head — neural vs v0 (the Pelias port)

_Self-emitted by `scripts/eval/per-type-report.ts`. Both parsers graded through the same resolver (Part A) or on parse structure (Part B). Turns the state-of-affairs blog's anecdotes into per-type rates._

## Part A — coordinate accuracy by bucket (real OpenAddresses US, 2000 rows)

Both parsers through the same resolver, against real address points. Slices overlap (a row can be both directional and multi-word-locality); `plain` is the complement.

| bucket | n | neural loc-match | v0 loc-match | neural coord p50 km | v0 coord p50 km |
|---|--:|--:|--:|--:|--:|
| all rows | 2000 | 84.0% | 82.1% | 3.3 | 3.3 |
| directional street | 506 | 87.2% | 85.2% | 3.1 | 3.1 |
| multi-word locality | 509 | 90.0% | 84.7% | 3.1 | 3.0 |
| plain (neither) | 1152 | 81.5% | 80.9% | 3.4 | 3.4 |

## Part B — parse-structure win-rate on the headline types (generated, 150 each)

OpenAddresses has ~no PO boxes, intersections, or units, so these are templated from real OA cities; the truth is the known TYPE. We score whether each parser emits the correct STRUCTURE.

| type | n | neural correct | v0 correct |
|---|--:|--:|--:|
| po_box | 150 | 100.0% | 0.0% |
| intersection | 150 | 82.0% | 0.0% |
| unit (keeps designator) | 150 | 100.0% | 0.0% |

## Reading

- **The US edge is not uniform.** Neural's overall locality-match lead (+1.9pp) concentrates on addresses with structure the rules engine fumbles: multi-word localities +5.3pp, directional streets +2.0pp. On plain single-word-city addresses the two are a near-tie (+0.6pp). Coordinate p50 is identical across buckets — the difference is which CITY resolves, not the point's precision.
- **Structured types are a rout, by construction.** The Pelias port emits 0.0% correct structure on PO boxes, intersections, and units — no `po_box` tag, an intersection side dropped, the unit designator stripped. Neural emits them because it was trained on the negative space. The one honest gap: intersections, where neural is 82.0% — the templated `A & B` form trips it ~1 in 6.
- **Where we do NOT win:** nowhere does v0 beat neural per-bucket here, but the plain-address tie shows neural isn't meaningfully better on the simplest addresses, and the intersection miss is our internal frontier, not a v0 advantage.
- _Caveat:_ Part B is templated (real OA cities, synthetic forms) — it measures parse-structure capability, not real-world frequency.
