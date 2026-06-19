# The shipped US coordinate is meter-grade — the eval was grading the admin centroid (2026-06-18)

## TL;DR

`oa-resolver-eval` reported US coord **p50 3.3 km / p90 10 km** and we read that as the
assembled-coordinate ceiling — the number behind "the US bottleneck is rural gazetteer coverage."
It is the **admin-centroid** tier. Production doesn't stop there: `mailwoman/geocode-core.ts`'s
`geocodeAddress` runs a per-state situs + interpolation cascade over the #567 address-point layer
(124.9M US points) that the eval never wired. Graded against what actually ships, the same 10,000
US rows resolve to **p50 0.0 km, p90 1.0 km, 85.9% within 100 m, 90% within 1 km** — and only 12%
fall back to the admin centroid at all. The "coordinate bottleneck" was a measurement gap, not a
data gap and not a model gap. Fixed: `oa-resolver-eval --cascade` (`dd3628da`) now grades the
production coordinate.

## What happened

The eval builds a neural parse, resolves it through the WOF admin gazetteer, and takes the resolved
place's centroid as the coordinate. That centroid is honest as far as it goes — a city centroid is
legitimately tens of km from an edge address, which is exactly why we lead with admin-*match* rate
there, not the coordinate. The trouble is we then carried the 3.3 km admin number into the
head-to-head, the model card, and the docs as if it were the coordinate the product delivers.

It isn't. The `geocode` CLI and the `/api/geocode` service both run `geocodeAddress`, which reads
the parsed region, picks that state's situs + interpolation shards, and resolves through a coordinate
cascade: an exact address-point (rooftop/parcel) when the house number is on file, a house-number
interpolation along the street segment otherwise, and the admin centroid only when neither exists.
The eval simply called `resolveTree` with no shard options, so every row landed at the admin tier.
`copy-weights` is skipped on CI and the per-state shards are multi-GB, so nobody noticed the eval was
running a different, blunter path than production.

`--cascade` closes that: it builds a multi-state `ShardProvider` (per-row state selection), routes
the neural resolve through the same `address_point > interpolated > admin` cascade the geocoder
ships, and reports it as the `neural+cascade` arm. The default (no flag) stays byte-identical — the
admin-centroid headline is unchanged, so this adds the shipped coordinate beside it rather than
rewriting history.

## The numbers (self-emitted, `--cascade`, v1.5.0, anchor-on, 10k US OpenAddresses rows)

| parser | locality-match | region-match | resolved | coord p50 km | coord p90 km | p99 km |
|---|--:|--:|--:|--:|--:|--:|
| **neural** (admin centroid) | 98.0% | 100.0% | 100.0% | 3.3 | 10.0 | 159.4 |
| v0 (Pelias) | 95.5% | 99.5% | 99.7% | 3.4 | 11.0 | 259.1 |
| **neural+addrpt** | 98.0% | 100.0% | 100.0% | 0.0 | 2.9 | 19.9 |
| **neural+cascade (SHIPPED coord)** | 98.0% | 100.0% | 100.0% | 0.0 | 1.0 | 18.3 |

`neural+cascade` is the production coordinate (`geocode-core.ts`: address_point > interpolated >
admin, per-state shards). **Tier share: address_point 79.8%, interpolated 8.2%, admin 12.0%. Within
100 m: 85.9% · within 1 km: 90.0% (n=10,000).** The entire residual coordinate error lives in the
12% admin tail — rows in places with no situs/interpolation point coverage, where the centroid is
the honest best estimate.

**Update (post-fix, 2026-06-19):** characterizing that 12% admin tail (#723) found 54% of it
recoverable with no new data, and two fixes from this diagnostic's follow-up landed it on the same
10k rows — the directional-quadrant street-key fold (`d1b8bcbe`: a quadrant the model mis-tagged
`unit`, "Taylor Street NE") and the US-gated 5-digit-house-number-as-ZIP relabel (`5977ce4d`:
"24588 Outback Trl" → house_number, with the FR reversed-order #560 shard left untouched, gate-
verified `fr.house_number` flat). Re-measured: **address_point 79.8 → 83.5%, interpolated 8.2 →
9.7%, admin 12.0 → 6.8%; within 100 m 85.9 → 90.0%, within 1 km 90.0 → 94.8%, cascade p99 18.3 →
10.9 km.** The admin tail is now under 7%, and the remaining bulk is a situs shard theme-reselect
(the SD/IL holes are in Overture's OpenAddresses theme, not the sparser NAD theme we ingested), not
a coverage gap — #723.

## Why this matters

This is the same trap as the #375 localadmin scoring artifact and the #566 reconcile regression:
**grade the assembled output the product actually ships, not an intermediate.** The new twist is the
direction — every prior instance had us *over*-reporting (a metric looking better than the shipped
behavior); this one had us *under*-reporting by three orders of magnitude. A model can win on labels
while the assembled address resolves wrong (the #566 case); it can also resolve street-accurate while
the eval reports a city centroid (this case). Both are fixed by the same discipline: pull the rows,
run what ships over them, grade that.

It also retires "the US coordinate bottleneck is rural gazetteer coverage." The rural states aren't
the laggards once you grade the cascade — SD and VT land their addresses at the address-point tier
like everywhere else; their lower *locality-match* (VT 93.8%, IA 95.8%) is a separate, mostly
naming-convention residual (civic suffixes like "Barre" vs "Barre Town", ~71% of the 2% miss), not a
coordinate problem. The next US coordinate gain is point-data coverage for the 12% admin tail, not a
retrain and not more gazetteer breadth.

## Caveats

- **The cascade needs the data layer.** The bare `@mailwoman/neural-weights-*` weights plus the admin
  gazetteer give the admin centroid; the meter-grade coordinate requires the per-state situs +
  interpolation shards wired in (the server's `ShardProvider`, the CLI's `--address-points` /
  `--interpolation`, or `--cascade` here). The shards are not in the npm package — they are the data
  release the geocoder consumes.
- **Ship-config parity is partial.** The eval feeds the postcode **anchor** (the dominant channel for
  admin recovery, which reproduces the 98.0% headline) but builds the classifier manually, so it does
  not yet feed the gazetteer/conventions channels. Routing it through the canonical `createScorer`
  for full ship-config parity is a tracked follow-up; it does not affect the coordinate result here.
- **Locality-match residual is separate.** The ~2% locality miss is mostly civic-suffix /
  coincident-municipality naming, not absent places — a metric-fairness item, not a coverage hole.

Raw report: `oa-resolver-eval --cascade` self-emitted via `--out-md`. Reproduces the situs-cascade
diagnostic run independently through `geocodeAddress` over the same rows (p50 0.0 / p90 1.0 / 85.9%
within 100 m).
