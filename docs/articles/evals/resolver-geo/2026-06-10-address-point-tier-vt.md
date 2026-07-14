# Address-point tier — VT prototype measurement (2026-06-10, night-10)

The #476 prototype: exact `(street, number)` → exact situs point, in front of admin-centroid
resolution. Shard from Overture release 2026-05-20.0 (NAD lineage), keyed by THE shared
normalizer (`resolver-wof-sqlite/street-normalize.ts`) on both build and lookup sides.

## VT holdout (1,428 honest rows, v4.2.0 int8, tier on vs off)

| tier                             | locality-match | region-match |  coord p50 |  coord p90 |  coord p99 |              hit rate |
| -------------------------------- | -------------: | -----------: | ---------: | ---------: | ---------: | --------------------: |
| admin-centroid (today's default) |          93.8% |        99.9% |     3.4 km |     7.4 km |   277.4 km |                     — |
| **+ address-point**              |          93.8% |        99.9% | **0.0 km** | **0.0 km** | **6.2 km** | **93.1%** (1330/1428) |

The tier changes _where_, never _which place_ — admin flags are identical by construction
(the hook decorates the street node's metadata after the admin walk; it cannot alter
attribution). On a hit, the resolved coordinate is the actual building: gold OA points and
Overture NAD points agree to meters. The 6.9% miss population is exactly what house-number
interpolation (#483) exists for — and this shard is its gold standard.

## Rollout decision note

- **Shard shape: per-state.** VT = 333,610 points → 56 MB (~168 B/point); full US
  extrapolates to ~21 GB — fine on the playpen as per-state files, a non-starter as one
  artifact. Build is `scripts/build-address-point-shard.ts --state XX` (~1 min/small state),
  idempotent, release-pinned.
- **Postcode scope first, locality fallback.** Postcode is the selective key and dodges the
  municipal-legal-name trap: NAD localities are charter names (`Barre City`,
  `Saint Albans City`) while parses say "Barre" — and VT's Barre City ≠ Barre Town, so the
  locality key stays EXACT (no suffix stripping; conflating those two would be a real
  wrong-answer class). Rows lacking a postcode in the query lean on locality and will miss
  more — measured, accepted for the prototype.
- **No fuzz.** Exact-after-normalization got 93.1% on real holdout traffic; fuzzy street
  matching is a separate, later decision with its own eval.
- **Tier policy:** opt-in `ResolveOpts.addressPoints` (an injected `AddressPointLookup`),
  default absent = byte-stable. Server-side (Tier B) data; pocket-tier delivery is out of
  scope (#378's two-tier split).

Next: DE/FR shards need the analogous Overture pulls (street/number fill ≈100% in both);
US rollout = build the state list + a shard-routing wrapper (state → db path) behind the
same interface.
