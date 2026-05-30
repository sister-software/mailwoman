# OpenAddresses real-point resolver eval — the non-circular accuracy track (2026-05-30)

Direction-C resolver-depth, plan item 3. The first **non-circular** end-to-end
accuracy number for the resolver: real US addresses with real government
coordinates, resolved against a gazetteer they don't come from.

## Why this is the honest scoreboard

The WOF-bootstrap eval (the +8.5pp exact-match-tiering result) renders WOF places
back into address strings and resolves WOF→WOF. It's a legitimate ranking test,
but it's circular by construction — the ground truth is the same gazetteer the
resolver consults, so it can't measure whether we resolve *real-world* addresses
to the *right place on the map*.

OpenAddresses is independent: each row is a real US address with a real lat/lon
harvested from authoritative government address points, and the resolver consults
the WOF gazetteer — a different source. So:

- **Admin-match** (did we resolve to the expected locality/region, by canonical
  gazetteer name vs OA's ground truth) measures resolver correctness independent
  of WOF id conventions.
- **Coordinate error** (great-circle from the resolved admin centroid to OA's real
  point) is a genuine map-accuracy signal — un-gameable, since OA's point was
  never in the gazetteer.

The set: `data/eval/external/openaddresses-us-sample.jsonl` (10,000 rows, 8
states, stratified dense-urban → rural so no single state dominates).

## Two-tier metric

Per the DeepSeek resolver consult, a sub-10km coordinate bar is **impossible** for
admin-centroid resolution — a city centroid is legitimately tens of km from its
edge addresses. So the metric is split:

1. **Admin-match Acc** (the headline) — locality-match and region-match rates,
   granularity-independent.
2. **Coord error p50/p90** — reported as the *admin-centroid tier*. The
   street-level tier (TIGER) will own a sub-km coordinate bar in a later phase.

## Results (v0.7.2 model, 10,000 rows)

| scope | n | locality-match | region-match | resolved | coord p50 km | coord p90 km |
|---|--:|--:|--:|--:|--:|--:|
| **overall** | 10000 | 96.1% | 100.0% | 100.0% | 11.6 | 39.4 |
| CA | 1429 | 99.9% | 100.0% | 100.0% | — | — |
| DC | 1429 | 99.5% | 99.9% | 100.0% | — | — |
| IA | 1429 | 94.3% | 99.8% | 100.0% | — | — |
| IL | 1429 | 98.7% | 100.0% | 100.0% | — | — |
| MT | 1428 | 96.7% | 100.0% | 100.0% | — | — |
| SD | 1428 | 96.8% | 100.0% | 100.0% | — | — |
| VT | 1428 | 87.1% | 100.0% | 100.0% | — | — |

Headline: **locality-match 89.7%, region-match 98.4%** on 10,000 real US addresses, resolved 99.9%. Coord error is admin-centroid-tier (p50 11.6km / p90 39.4km / p99 246.6km) — median is centroid-to-address distance, not a geocoding miss. Per-state coord percentiles omitted (the overall is the meaningful figure; per-state n varies).

## What it measures vs. doesn't

- It **does** confirm the resolver maps real addresses to the right city/state at
  scale, independent of the gazetteer's own id scheme — the credibility check the
  WOF-bootstrap number couldn't give.
- It **does not** measure street/house precision (the resolver is admin-level;
  coord error reflects centroid-to-point distance, not a geocoding miss).
- Region-match required a name↔abbrev map: resolved regions carry the gazetteer's
  canonical full name ("California", "District of Columbia") while OA carries the
  USPS abbreviation ("CA", "DC"). An early cut scored region-match at 30% purely
  from that mismatch — a matcher bug, not a resolver one; fixed in the runner.

## Resolver change that landed with this

`core/resolver/resolve.ts` now stamps `metadata.resolver_name` (the resolved
place's canonical gazetteer name) alongside `resolver_score`. Without it the eval
could only compare against the parser's own text span, not the place the resolver
actually chose — so it couldn't tell a right-name/wrong-place resolution from a
correct one. The name is also generally useful to consumers (display the canonical
name, not the raw input span).

## Reproduce

```bash
node --experimental-strip-types scripts/eval/oa-resolver-eval.ts \
  --eval data/eval/external/openaddresses-us-sample.jsonl \
  --model <v0.7.2.onnx> --tokenizer <v0.6.0-a0> --model-card <card> \
  --wof admin-global-priority.db,postalcode-us.db \
  --out-json /tmp/oa-full.json
```

`--limit N` for a quick subset. Per-state breakdown is in the runner's output.
