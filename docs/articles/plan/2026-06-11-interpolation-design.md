# House-number interpolation — design (#483, slice 1)

First slice of the interpolation tier scoped in
[2026-06-11-geocoder-table-stakes-scoping.md](./2026-06-11-geocoder-table-stakes-scoping.md):
"123 Main St" where no address point exists → estimate the coordinate between known ranges
along the street segment. This document covers the pilot — a Vermont-scoped TIGER EDGES
segment table, a standalone interpolation module in `resolver-wof-sqlite`, and the honest
eval that grades it against real address points.

## Where it sits in the resolution ladder

```
exact address point  (#476, AddressPointSqliteLookup — situs coordinate, tier "address_point")
        ↓ miss
interpolation        (#483, StreetInterpolator — THIS DOC, tier "interpolated")
        ↓ miss
admin centroid       (locality/region/country — the existing WOF resolver answer)
```

The interpolator only ever answers when the exact-point tier missed, and its answer is
always flagged: `interpolated: true` plus an `uncertaintyM` radius (half the matched
segment's length — the honest default from the #483 issue). Same honesty convention as
`reverse.ts`'s `containment: "approximate"` and the demo's approximate circles: data
reality surfaced per result, never hidden.

## Data: TIGER EDGES

The same per-county shapefiles the real-intersection eval already reads
(`scripts/eval/build-intersection-real.ts`, DuckDB spatial `ST_Read`, downloaded from
`www2.census.gov/geo/tiger/TIGER2023/EDGES/tl_2023_<countyfips>_edges.zip` into
`/tmp/tiger-edges/`). Each road edge carries:

| Field               | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `FULLNAME`          | Street name as TIGER spells it (`State Route 12`, `Main St`) |
| `LFROMADD`/`LTOADD` | House-number range on the LEFT side, walking from→to node    |
| `RFROMADD`/`RTOADD` | House-number range on the RIGHT side                         |
| `ZIPL`/`ZIPR`       | ZIP code per side                                            |
| `MTFCC`             | Feature class — `S1…` is a road                              |
| `geom`              | The segment polyline (WGS84 lon/lat)                         |

TIGER conventions that shape the schema:

- **Sides are independent.** Left and right carry separate ranges and separate ZIPs (a
  street can be a ZIP boundary). We emit one ROW PER SIDE, not per edge.
- **Parity is per side, by convention but not by contract.** Typically one side of a US
  street is odd and the other even, and TIGER's from/to numbers usually agree on parity
  (Vermont: 137,248 of 137,256 sides). When from/to parity DISAGREES the side is recorded
  `parity = "mixed"` and matches either parity. Per-side fidelity is an open question
  below — we measure it, we don't assume it.
- **Ranges may descend.** `from > to` means house numbers decrease walking from-node →
  to-node. The row keeps the raw from/to (the interpolation position needs the
  direction); the index columns store `min`/`max` for range matching.
- **Ranges are potential, not actual.** TIGER ranges are theoretical capacity
  (`100–198`), not occupancy. Interpolating assumes uniform spacing across the range —
  the classic source of interpolation error, which is exactly what the eval measures.
- **Non-numeric house numbers exist** (hyphenated Queens-style `12-34`, alphanumeric
  suffixes). The pilot keeps numeric-only sides and counts what it skips.

## Segment table schema

One SQLite DB per state, built by `scripts/build-interpolation-shard.ts` (the
`build-address-point-shard.ts` pattern: idempotent rebuild, provenance per row, THE shared
street normalizer):

```sql
CREATE TABLE street_segment (
  street_norm  TEXT NOT NULL,   -- normalizeStreetForKey(FULLNAME) — the shared normalizer
  side         TEXT NOT NULL,   -- 'L' | 'R'
  from_hn      INTEGER NOT NULL,-- raw TIGER from (may exceed to_hn)
  to_hn        INTEGER NOT NULL,
  min_hn       INTEGER NOT NULL,-- min(from,to) — range-match column
  max_hn       INTEGER NOT NULL,
  parity       TEXT NOT NULL,   -- 'odd' | 'even' | 'mixed'
  postcode     TEXT,            -- ZIPL or ZIPR for this side
  county_fips  TEXT NOT NULL,   -- scope + provenance
  street_raw   TEXT NOT NULL,   -- FULLNAME as shipped
  geometry     TEXT NOT NULL,   -- JSON [[lon,lat],…] polyline, from-node first
  source       TEXT NOT NULL,   -- 'tiger:edges'
  release      TEXT NOT NULL    -- 'TIGER2023'
);
CREATE INDEX idx_seg_postcode ON street_segment (postcode, street_norm, min_hn);
CREATE INDEX idx_seg_street   ON street_segment (street_norm, min_hn);
```

Keying reuses `resolver-wof-sqlite/street-normalize.ts` — the SAME function the
address-point shard and lookup use (one normalizer, never two; the PLACETYPE_ORDER
lesson) — plus `canonicalizeRouteKey`, a route-designator fold applied by BOTH the
builder and the lookup. Measured need: TIGER spells routes `State Rte 100` / `US Hwy 5`
where E911/Overture say `VT ROUTE 100` / `US ROUTE 5` — the single largest street-name
miss class in the VT eval (+3.1pp coverage from the fold alone, no tail cost). The
address-point tier does not apply the fold yet; adopting it there needs a #476 shard
rebuild (follow-up). Geometry is a plain JSON polyline: segments are short, the per-row
cost is small at state scale, and it keeps the reader dependency-free — revisit encoding
only if a national build makes size hurt.

**Scoping is postcode-first, like the address-point tier.** TIGER edges carry no
locality name, so locality scope can't be matched directly against this table — a known
limitation of this slice (see open questions). Queries without a postcode fall back to a
statewide street-name match, which is honest but ambiguous for common names ("Main
Street" exists in many towns); the lookup ABSTAINS when the statewide candidates span
multiple postcodes with no way to pick.

## Query algorithm (`resolver-wof-sqlite/interpolation.ts`)

Given `{ street, number, postcode? }`:

1. **Normalize** street via `normalizeStreetForKey`; parse `number` as a non-negative
   integer (non-numeric → no answer, this tier doesn't guess).
2. **Candidate fetch** — rows with `street_norm` equal and `min_hn ≤ n ≤ max_hn`,
   postcode-scoped when a postcode is given. A given ZIP that scopes to nothing is a
   MISS, not a statewide guess — the statewide retry was built and MEASURED (2026-06-11
   VT eval): +2.3pp coverage but a poisoned tail (p99 1.0 → 20.8 km, max 204 km — a
   statewide-unique name can live in a far-away town), so it was reverted. Queries
   WITHOUT a postcode match statewide and abstain unless every candidate agrees on a
   single ZIP.
3. **Parity match** — prefer sides whose `parity` equals the number's parity, then
   `mixed`, then opposite-parity as a last resort (an opposite-parity hit is usually the
   right block, wrong side of the street — tens of meters, not kilometers; the result
   reports `parityMatched: false` so callers and the eval can see it).
4. **Pick** the tightest range (smallest `max_hn − min_hn`) among the preferred group —
   the most specific claim wins.
5. **Interpolate** — `t = (n − from_hn) / (to_hn − from_hn)` (0.5 when the range is a
   single number), clamped to [0, 1], then walk the polyline by cumulative haversine arc
   length to the point at fraction `t`. Descending ranges need no special case: `t` is
   computed against the raw from/to, which already encodes direction.
6. **Answer** — `{ lat, lon, interpolated: true, parityMatched, uncertaintyM, source,
release }` where `uncertaintyM` is half the segment's polyline length in meters.

No side-of-street offset in this slice: TIGER centerline + half-segment uncertainty is
the honest claim. Offsetting perpendicular by ~10 m to the matched side is a cheap
follow-up once the eval says the centerline is the dominant error term (it isn't — range
uniformity is).

## Resolver tier placement

`core/resolver/resolve.ts` already runs the exact-point tier via `opts.addressPoints`
(`applyAddressPoint`, stamping `resolution_tier: "address_point"`). The interpolation
tier slots in immediately after it as the fall-through: same `(street, number, postcode,
locality)` extraction, consulted ONLY when the exact tier missed, stamping
`resolution_tier: "interpolated"` + the uncertainty metadata.

**This slice ships the module standalone and does NOT wire core.** The wiring needs a
second `ResolveOpts` member (or a widening of `addressPoints` into an ordered tier list)
and that interface decision deserves its own review — noted as a follow-up on #483
rather than smuggled into the pilot. The module's `find()` signature is deliberately
identical in shape to `AddressPointLookup.find()` so the wiring is mechanical when it
lands.

## Eval — honest-eval pattern at street grain

`scripts/eval/interpolation-eval.ts`, self-reporting. The gold is the #476 address-point
shard (`address-points-us-vt.db`, Overture 2026-05-20.0 — NAD/E911-lineage situs
points): an independent source from TIGER, so grading against it is non-circular. For a
deterministic held-out sample of Vermont points:

- query `(street_raw, number, postcode)` through the interpolator,
- **coverage** — fraction that found a segment at all,
- **coord error** — haversine meters vs the true point, reported p50/p90 (plus the
  parity-matched/fallback split),
- graded against the #483 pre-registered gate: **p50 ≤ 50 m, p90 ≤ 150 m** on the VT
  holdout before any rollout.

These are points the exact tier would mostly HIT — the eval uses them precisely because
truth is known. The production value is the complement (numbers with no point), where
truth is unknowable; measuring on known points is the only honest proxy.

## Pilot results (2026-06-11, VT, 5000-key sample, seed 42)

- **Coverage 82.0%** (4100/5000 found a segment). Miss composition: 469 name-absent in
  TIGER (private roads, new subdivisions, E911-only names like `CHARBO UNKNOWN 6`), 232
  range-gaps within the right ZIP+name, 166 ZIP-mismatches (name+range exists in a
  neighbouring ZIP — the class the rejected statewide retry would have answered, badly),
  33 range-gaps statewide.
- **Coord error vs truth: p50 66 m, p90 249 m** (p99 1.0 km; parity-matched n=3927 p50
  65 m / fallback n=173 p50 116 m). Median claimed uncertainty (half segment length)
  137 m — the p50 error sits inside the claimed radius.
- **Gate: MISS.** The pre-registered #483 gate (p50 ≤ 50 m, p90 ≤ 150 m) is NOT met —
  stated plainly, not re-baselined. The shortfall tracks rural Vermont's long sparse
  segments (median claimed uncertainty 137 m: the geometry itself caps precision) and
  TIGER's uniform-spacing assumption. Next levers, in measured-first order: re-run on a
  denser county (the gate may simply be a rural-geometry artifact — measure before
  building), segment subdivision at OA point anchors, ZIP+4 snapping (#525). No rollout
  until a gate pass or a STATED re-baseline with operator sign-off.

## Open questions

1. **Workspace split.** This slice implements inside `resolver-wof-sqlite` (the module is
   small, shares the normalizer + geo helpers, and ships nothing by default). The scoping
   note leaned toward a new `@mailwoman/resolver-interpolation` workspace — different
   data lifecycle (TIGER yearly vintages vs WOF), the slim/fat split the demo taught.
   **Operator call** before this grows beyond a pilot: stay (one fewer package, shared
   normalizer stays intra-package) vs split (independent versioning of the TIGER data
   contract). Nothing in this slice blocks either answer.
2. **Odd/even fidelity.** Vermont measures 99.99% of address-carrying sides
   parity-consistent (8 `mixed` of 137,256), but a clean from/to pair doesn't prove the
   real houses obey it, and TIGER does not guarantee it nationally; the `mixed` bucket and
   the opposite-parity fallback are the pressure valves. The eval's parity-split
   reporting is the instrument — if fallback hits dominate the error tail in a denser
   state, revisit before national rollout.
3. **Locality scope.** TIGER carries ZIPs, not locality names. A locality-only query
   (no postcode) currently rides the statewide fallback + abstention. Joining ZIP →
   locality via the postcode shard (or place ancestry) would restore locality scoping —
   follow-up, not pilot.
4. **ZIP+4 snapping** — deferred to #525 (needs the ZCTA work as a prior), per scoping.
5. **EU rollout** — OSM Karlsruhe-schema `addr:interpolation` ways, with the ODbL
   share-alike treatment documented in #26. Out of scope for the US pilot.
