# The resolution ladder — coordinate resolution plan (2026-06-11)

This document replaces two working drafts (the operator's interpolation musings and DeepSeek's
plan synthesis, both reviewed 2026-06-11 and deleted in favor of this). It keeps what passed
review, drops what conflicts with settled architecture, and re-sequences the correctives. It is
the planning home for #483 (interpolation), the unbuilt spatial tiers, and the confidence model
that sits over all of them. #484 (reverse) ships and continues on its own issue.

## The principle, and the ladder

Prefer exact locations; interpolate only as a fallback; expose confidence and provenance on
every answer. That has been this project's posture all along (`resolution_tier`,
`interpolated: true`, `uncertaintyM`, `approximate` containment, `source`/`release` per row).
The musings contributed a shared vocabulary for the whole ladder, which we adopt:

| Rung | Tier                                     | Status                                                                |
| ---- | ---------------------------------------- | --------------------------------------------------------------------- |
| 1    | Entrance point                           | unbuilt (future, behind footprints)                                   |
| 2    | Rooftop / building centroid              | unbuilt — rides Overture buildings (#470)                             |
| 3    | Address point                            | ✅ #476, wired (`applyAddressPoint`)                                  |
| 4    | Parcel centroid                          | unbuilt, deliberately deferred (US parcel data is patchwork-licensed) |
| 5    | Address-point interpolation ("Method 2") | **the next corrective — see Phase 1**                                 |
| 6    | Street-range interpolation (TIGER)       | ✅ #483 pilot, standalone, check MISS on record                       |
| 7    | OSM interpolation ways                   | blocked on ODbL treatment (#26)                                       |
| 8    | Street centerline                        | implicit today (segment match without number)                         |
| 9    | Admin centroid (locality → region)       | ✅ the WOF resolver                                                   |

Every tier answers the same shape, `(street, number, postcode/locality scope)` → flagged
coordinate, so the resolver walks an ordered list and the first hit wins. From here on, each
new tier is a data problem rather than an architecture problem.

## Stack positions (reaffirmed rather than open)

The musings recommended OpenSearch/Elasticsearch for search and PostGIS for the spatial layer.
We decline both, on existing grounds: the stated goal explicitly excludes Elasticsearch
(hierarchy lives in-DB via the `ancestors` table), and the deployment model (slim DBs over
httpvfs, the browser tier, static-asset hosting) depends on sqlite everywhere. Our search
layer is FTS5 + the FST + the typo-tolerant retrieval tier now scoped in #531; our spatial
layer is the R\*Tree + ray-cast PIP that #484 shipped. The musings' fuzzy-matching section is
#531 in different words; its autocomplete section is #190. Both were already queued.

Likewise "avoid full reindexing": our artifacts are immutable provenance-tracked extracts rebuilt
per source vintage (TIGER yearly, Overture monthly). That rebuild cadence is how
updates arrive, and we do not take on incremental index mutation.

## Phase 1 — the check corrective, re-sequenced

The #483 pilot missed its pre-registered check (p50 66 m vs ≤ 50, p90 249 m vs ≤ 150, VT,
n=5000). The dominant error term is TIGER's uniform-spacing assumption over long rural
segments. Review combined the two proposed correctives into one decision:

**Method 2 (address-point interpolation) is the primary corrective, promoted from "Phase 5"
to now.** Segment-subdivision-at-anchors and address-point interpolation are nearly the same
computation (bracket the query number with known points, interpolate between them), but Method
2 is simpler. It needs no TIGER data, because the #476 Overture extract alone supplies
the known points. It also replaces theoretical capacity ranges with real occupancy, which is
the error term behind the failed check. TIGER range interpolation becomes the fallback for
streets too sparse to bracket.

Order of work:

1. **Density characterization first** (nearly free): re-run the existing eval on a dense county
   (Cook IL or Kings NY class). If dense passes and VT fails, the miss is geometry-capped and
   the check becomes county-stratified through a stated re-baseline with operator sign-off, never an
   unannounced edit. If dense also fails, the method itself needs the corrective regardless.
2. **Method 2 implementation**: given `(street, number, scope)`, find bracketing address points
   on the normalized street and interpolate linearly between them. A single-sided bracket
   extrapolates with an explicit uncertainty penalty. Without a bracket, fall through to TIGER.
   Use the same direct-eval harness and the same gold, and interpolate held-out points only from
   non-held-out neighbors (non-circular by construction).
3. **Side-of-street offset** (~10 m perpendicular on parity match) comes only after the above,
   because it is not the dominant term.
4. ZIP+4 snapping stays deferred behind #525.

The check changes only by stated decision. A second miss gets its own postmortem.

## Phase 2 — resolver wiring + the workspace split

- **Tier interface: the ordered list** (DeepSeek's Option B, endorsed). `ResolveOpts` grows a
  `spatialTiers` ordered array of lookups sharing the `find()` shape; `addressPoints` becomes
  the first entry rather than a special case. We have two tiers today and a ladder of nine
  above, so per-tier opts members do not scale.
- **Workspace: split.** `@mailwoman/resolver-interpolation` becomes its own workspace because of the
  TIGER/Overture vintage lifecycle vs WOF's continuous one, the national extract size (hundreds of MB) vs the 9 MB
  gazetteer, and independent versioning. The shared street normalizer stays the single
  build-time/query-time function it already is. Do the split before national builds so they
  land in the right home.

## Phase 3 — nationalize

Multi-state TIGER + Overture extract orchestration (the builders are per-state already);
ZIP→locality scoping so "123 Main St Springfield" works without a postcode (build-time join of
segment ZIPs to locality names via WOF ancestry); OSM interpolation ways for EU coverage only
after #26 resolves ODbL treatment. The interpolation module stays source-agnostic. TIGER edges
and OSM ways are both `(street, from, to, parity, polyline)` rows, and only the builders know their sources.

## Phase 4 — building centroids (the highest unbuilt rung)

This is the most accurate tier not yet built (~10–20 m vs interpolation's 50–200 m), and it
is closer than it looks: Overture's buildings theme (Microsoft footprints folded in) arrives with the
#470 ingestion epic already staged. Spatial-join footprints to address points; rooftop
centroids where a point is missing. Parcels stay deferred behind this.

## Phase 5 — confidence, calibrated not hand-assigned

The musings proposed static weights (rooftop 0.95, interpolated 0.50, …). We keep the _ordering_
as a prior and reject the constants. This project already calibrates confidence (the isotonic
work), and tier confidence should be **measured**: P(error < X m) per tier per density
stratum, fitted from the evals we already run and recalibrated when extracts rebuild. Hand-assigned
constants have no measured basis. Provenance extends to a structured chain
(dataset, release, tier, fallback flag). The fields already exist per row, so the chain only
needs assembling.

## Phase 6 — learned placement (research track, strictly conditional)

The novel idea in the musings: replace linear interpolation with a model that
predicts where addresses sit on a block. Review kept it as research, with two
corrections. First, drop the location-encoder framing. GeoCLIP/SatCLIP encode _global_
position for geo-localization, while this problem is _where along a 200 m segment_, and the
informative features are segment-local (bracketing-number positions, density, footprint
geometry). SatCLIP's own card rules out fine-grained several-close-location use. Second, the
baseline to beat is Method 2 itself, which is already nearest-neighbor regression on real
data. A learned model must beat it per density stratum on the same held-out gold, with the deterministic
tier as the abstain fallback. There is no ship commitment until it does.

## Sequencing

```
Now    Phase 1  density characterization → Method 2 → re-check
Next   Phase 2  ordered spatialTiers + workspace split          (then) Phase 3 nationalize
Then   Phase 4  building centroids (rides #470)
Later  Phase 5  calibrated confidence  ·  Phase 6 learned placement (parallel research)
```

## Decisions (ruled 2026-06-11 unless marked open)

| Decision                 | Ruling                                                              |
| ------------------------ | ------------------------------------------------------------------- |
| Search/spatial stack     | sqlite + FTS5 + FST + R\*Tree/PIP, without ES or PostGIS (standing) |
| Primary check corrective | Method 2 promoted to Phase 1; TIGER demotes to fallback             |
| Tier interface           | Option B ordered `spatialTiers` list                                |
| Workspace                | split to `@mailwoman/resolver-interpolation` before national builds |
| Check re-baseline        | only county-stratified, only by stated sign-off                     |
| OSM ways                 | blocked on #26 (ODbL)                                               |
| Learned placement        | research-only; check = beat Method 2 stratified                     |
| Parcel tier              | deferred behind building centroids                                  |
