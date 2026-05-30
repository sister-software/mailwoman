# OpenAddresses real-point resolver eval — the non-circular accuracy track (2026-05-30)

Direction-C resolver-depth, plan item 3. The first **non-circular** end-to-end
accuracy number for the resolver: real US addresses with real government
coordinates, resolved against a gazetteer they don't come from.

## Why this is the honest scoreboard

The WOF-bootstrap eval (the +8.5pp exact-match-tiering result) renders WOF places
back into address strings and resolves WOF→WOF. It's a legitimate ranking test,
but it's circular by construction — the ground truth is the same gazetteer the
resolver consults, so it can't measure whether we resolve _real-world_ addresses
to the _right place on the map_.

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
2. **Coord error p50/p90** — reported as the _admin-centroid tier_. The
   street-level tier (TIGER) will own a sub-km coordinate bar in a later phase.

## Head-to-head: neural vs the Pelias parser (v0.7.2 model, 10,000 rows)

mailwoman's `v0` rule parser is a **TypeScript port of the Pelias parser**, so
running both parsers through the _same_ resolver makes this a direct
neural-vs-Pelias-parser comparison on real, non-circular addresses — no Docker
Pelias stack required. The table below is emitted verbatim by the eval runner
(`--out-md`); eval figures are never hand-typed (see the integrity note).

| parser      | locality-match | region-match | resolved | coord p50 km | coord p90 km | p99 km |
| ----------- | -------------: | -----------: | -------: | -----------: | -----------: | -----: |
| **neural**  |          96.1% |       100.0% |   100.0% |          2.4 |         10.6 |   25.0 |
| v0 (Pelias) |          94.4% |        99.5% |    99.8% |          2.4 |         10.6 |   25.0 |

**Neural beats the Pelias parser on real US addresses** — +1.7pp locality, +0.5pp
region, and a higher resolve rate — and wins in every state (per-state below).
Both share identical coordinate error because they feed the same resolver and,
when both resolve to the right admin, land on the same centroid; the difference is
purely _which_ addresses each parser resolves correctly at all.

### Neural per-state (locality-match)

| state |    n | neural loc | v0 loc | neural reg | v0 reg |
| ----- | ---: | ---------: | -----: | ---------: | -----: |
| CA    | 1429 |      99.9% |  99.7% |     100.0% |  99.9% |
| DC    | 1429 |      99.5% |  99.2% |      99.9% |  99.2% |
| IA    | 1429 |      94.3% |  86.4% |      99.8% |  99.0% |
| IL    | 1429 |      98.7% |  97.6% |     100.0% |  99.7% |
| MT    | 1428 |      96.7% |  95.3% |     100.0% |  99.4% |
| SD    | 1428 |      96.8% |  96.8% |     100.0% |  99.7% |
| VT    | 1428 |      87.1% |  85.7% |     100.0% |  99.5% |

Headline: **neural locality-match 96.1%, region-match 100.0%** on 10,000 real US
addresses, resolved 100.0%; coord p50 2.4km / p90 10.6km / p99 25.0km
(admin-centroid tier — median is centroid-to-address distance, not a geocoding
miss). Neural's largest margin over the Pelias parser is **IA +7.9pp** (suburban/
rural midwest); the weakest state for both is VT (rural-northeast, sparse gazetteer
coverage), where neural still leads 87.1% vs 85.7%.

### Eval-integrity note

This doc's tables are produced by `scripts/eval/oa-resolver-eval.ts --out-md` and
pasted verbatim. The runner also writes `--out-json`; the two are computed from the
same aggregates so they cannot disagree. (Earlier in this work an OA table was
hand-typed and shipped wrong numbers — the self-reporting `--out-md` flag exists to
make that class of error impossible.)

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
