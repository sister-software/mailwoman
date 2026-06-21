# The resolution ladder — coordinate resolution plan (2026-06-11)

This document replaces two working drafts (the operator's interpolation musings and DeepSeek's
plan synthesis, both reviewed 2026-06-11 and deleted in favor of this). It keeps what survived
review, drops what conflicts with settled architecture, and re-sequences the correctives. It is
the planning home for #483 (interpolation), the unbuilt spatial tiers, and the confidence model
that sits over all of them. #484 (reverse) ships and continues on its own issue.

## The principle, and the ladder

Prefer exact locations; interpolate only as a fallback; expose confidence and provenance on
every answer. That has been this project's posture all along (`resolution_tier`,
`interpolated: true`, `uncertaintyM`, `approximate` containment, `source`/`release` per row) —
the musings' contribution is a shared vocabulary for the whole ladder, which we adopt:

| Rung | Tier                                     | Status                                                                |
| ---- | ---------------------------------------- | --------------------------------------------------------------------- |
| 1    | Entrance point                           | unbuilt (future, behind footprints)                                   |
| 2    | Rooftop / building centroid              | unbuilt — rides Overture buildings (#470)                             |
| 3    | Address point                            | ✅ #476, wired (`applyAddressPoint`)                                  |
| 4    | Parcel centroid                          | unbuilt, deliberately deferred (US parcel data is patchwork-licensed) |
| 5    | Address-point interpolation ("Method 2") | **the next corrective — see Phase 1**                                 |
| 6    | Street-range interpolation (TIGER)       | ✅ #483 pilot, standalone, gate MISS on record                        |
| 7    | OSM interpolation ways                   | blocked on ODbL treatment (#26)                                       |
| 8    | Street centerline                        | implicit today (segment match without number)                         |
| 9    | Admin centroid (locality → region)       | ✅ the WOF resolver                                                   |

Every tier answers the same shape — `(street, number, postcode/locality scope)` → flagged
coordinate — so the resolver walks an ordered list and the first hit wins. Tiers are data
problems, not architecture problems, from here on.

## Stack positions (reaffirmed, not open)

The musings recommended OpenSearch/Elasticsearch for search and PostGIS for the spatial layer.
We decline both, on existing grounds: the north star explicitly excludes Elasticsearch
(hierarchy lives in-DB via the `ancestors` table), and the deployment story — slim DBs over
httpvfs, the browser tier, static-asset hosting — depends on sqlite everywhere. Our search
layer is FTS5 + the FST + the typo-tolerant retrieval tier now scoped in #531; our spatial
layer is the R\*Tree + ray-cast PIP that #484 shipped. The musings' fuzzy-matching section is
#531 in different words; its autocomplete section is #190. Both were already queued.

Likewise "avoid full reindexing": our artifacts are immutable provenance-tracked shards rebuilt
per source vintage (TIGER yearly, Overture monthly). That cadence is the update story; we do
not take on incremental index mutation.

## Phase 1 — the gate corrective, re-sequenced

The #483 pilot missed its pre-registered gate (p50 66 m vs ≤ 50, p90 249 m vs ≤ 150, VT,
n=5000). The dominant error term is TIGER's uniform-spacing assumption over long rural
segments. Two correctives were on the table; review collapsed them into one decision:

**Method 2 — address-point interpolation — is the primary corrective, promoted from "Phase 5"
to now.** Segment-subdivision-at-anchors and address-point interpolation are nearly the same
computation (bracket the query number with known points, interpolate between them), but Method
2 is the simpler of the two: it needs no TIGER at all — the #476 Overture shard alone supplies
the known points — and it replaces theoretical capacity ranges with real occupancy, which is
precisely the failed gate's error term. TIGER range interpolation demotes to what it should
always have been: the fallback for streets too sparse to bracket.

Order of work:

1. **Density characterization first** (nearly free): re-run the existing eval on a dense county
   (Cook IL or Kings NY class). If dense passes and VT fails, the miss is geometry-capped and
   the gate becomes county-stratified — by stated re-baseline with operator sign-off, never a
   quiet edit. If dense also fails, the method itself needs the corrective regardless.
2. **Method 2 implementation**: given `(street, number, scope)`, find bracketing address points
   on the normalized street; interpolate linearly between them; single-sided bracket =
   extrapolation with an explicit uncertainty penalty; no bracket = fall through to TIGER.
   Same honest-eval harness, same gold, held-out points interpolated only from non-held-out
   neighbors (non-circular by construction).
3. **Side-of-street offset** (~10 m perpendicular on parity match) only after the above — it is
   not the dominant term.
4. ZIP+4 snapping stays deferred behind #525.

The gate does not move except by stated decision. A second miss is a second postmortem.

## Phase 2 — resolver wiring + the workspace split

- **Tier interface: the ordered list** (DeepSeek's Option B, endorsed). `ResolveOpts` grows a
  `spatialTiers` ordered array of lookups sharing the `find()` shape; `addressPoints` becomes
  the first entry rather than a special case. We have two tiers today and a ladder of nine
  above — per-tier opts members do not scale.
- **Workspace: split.** `@mailwoman/resolver-interpolation` as its own workspace — TIGER/Overture
  vintage lifecycle vs WOF continuous, national shard size (hundreds of MB) vs the 9 MB
  gazetteer, independent versioning. The shared street normalizer stays the single
  build-time/query-time function it already is. Do the split before national builds so they
  land in the right home.

## Phase 3 — nationalize

Multi-state TIGER + Overture shard orchestration (the builders are per-state already);
ZIP→locality scoping so "123 Main St Springfield" works without a postcode (build-time join of
segment ZIPs to locality names via WOF ancestry); OSM interpolation ways for EU coverage only
after #26 resolves ODbL treatment. The interpolation module stays source-agnostic — TIGER edges
and OSM ways are both `(street, from, to, parity, polyline)` rows; only builders know sources.

## Phase 4 — building centroids (the highest unbuilt rung)

The best marginal-accuracy tier not yet built (~10–20 m vs interpolation's 50–200 m), and
closer than it looks: Overture's buildings theme (Microsoft footprints folded in) rides the
#470 ingestion epic already staged. Spatial-join footprints to address points; rooftop
centroids where a point is missing. Parcels stay deferred behind this.

## Phase 5 — confidence, calibrated not hand-assigned

The musings proposed static weights (rooftop 0.95, interpolated 0.50, …). We keep the _ordering_
as a prior and reject the constants: this project has a calibration discipline (the isotonic
work), and tier confidence should be **measured** — P(error < X m) per tier per density
stratum, fitted from the evals we already run, recalibrated when shards rebuild. Hand-assigned
constants are make-or-break trivia in number form. Provenance extends to a structured chain
(dataset, release, tier, fallback flag) — the fields already exist per row; the chain is
assembly.

## Phase 6 — learned placement (research track, strictly gated)

The genuinely novel idea in the musings: replace linear interpolation with a model that
predicts where addresses sit on a block. Verdict from review: keep it, as research, with two
corrections. First, drop the location-encoder framing — GeoCLIP/SatCLIP encode _global_
position for geo-localization; this problem is _where along a 200 m segment_, and the
informative features are segment-local (bracketing-number positions, density, footprint
geometry). SatCLIP's own card rules out fine-grained many-close-location use. Second, the
baseline to beat is Method 2 itself — which is already nearest-neighbor regression on real
data. The bar: beat it per density stratum on the same held-out gold, with the deterministic
tier as the abstain fallback. No ship commitment until that bar clears.

## Sequencing

```
Now    Phase 1  density characterization → Method 2 → re-gate
Next   Phase 2  ordered spatialTiers + workspace split          (then) Phase 3 nationalize
Then   Phase 4  building centroids (rides #470)
Later  Phase 5  calibrated confidence  ·  Phase 6 learned placement (parallel research)
```

## Decisions (ruled 2026-06-11 unless marked open)

| Decision                | Ruling                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| Search/spatial stack    | sqlite + FTS5 + FST + R\*Tree/PIP — no ES, no PostGIS (standing)    |
| Primary gate corrective | Method 2 promoted to Phase 1; TIGER demotes to fallback             |
| Tier interface          | Option B ordered `spatialTiers` list                                |
| Workspace               | split to `@mailwoman/resolver-interpolation` before national builds |
| Gate re-baseline        | only county-stratified, only by stated sign-off                     |
| OSM ways                | blocked on #26 (ODbL)                                               |
| Learned placement       | research-only; gate = beat Method 2 stratified                      |
| Parcel tier             | deferred behind building centroids                                  |
