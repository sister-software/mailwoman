# Geocoder table stakes — scoping notes (#483 interpolation, #484 reverse)

Scoping per the post-parity agenda (the Codex review's sequencing concurs: start these in
parallel with parser tail work, don't block on perfect parity). These are NOTES, not designs —
each gets its own design doc when picked up.

## #484 Reverse geocoding — assembly, not research

**Shape:** lat/lon → containing hierarchy. The pieces exist: `wof-polygons.db` (22,104
DP-simplified admin polygons), the R\*Tree bbox index (`place_bbox` in the hot DB), the
`coincident_roles` relation, and the PIP machinery the honest-eval harness already runs
(`pip-containment.py` proves the polygon→point test works at eval scale).

**Plan shape:** (1) bbox candidate fetch via R\*Tree → (2) PIP against the polygon DB
(point-geometry places fall back to nearest-centroid-within-bbox, flagged `approximate` — the
same honesty convention as the demo circles) → (3) ancestor chain from the resolver's existing
walk. Node first (`resolver-wof-sqlite`), browser via the same httpvfs split the demo proved.
**Eval**: the OA holdout rows ARE the eval (coordinates → known gold address components); the
honest-eval harness inverts almost for free. **Open question:** placetype granularity contract
(stop at locality vs descend to neighbourhood where WOF has it).

## #483 House-number interpolation — the coverage jump

**Shape:** "123 Main St" where no address point exists → estimate between known points. The
biggest forward-geocoding coverage lever (admin-centroid answers become street-accurate).

**Data:** the address-point shard work (#475-era `build-address-point-shard.ts` +
`AddressPointLookup` in `core/resolver/types.ts`) already gives exact-point hits; interpolation
fills BETWEEN them. TIGER EDGES carries from/to house-number ranges per street segment (the same
files the intersection shard reads — already on disk) — the classic Pelias/libpostal approach,
and our intersection extraction already parses the geometry. **Plan shape:** (1) segment table
keyed by normalized street name + side-aware ranges (TIGER LFROMADD/LTOADD etc.) → (2) linear
interpolation along segment geometry → (3) resolver tier between exact-point and
locality-centroid, output flagged `interpolated`. **Eval:** hold out a slice of NAD address
points, query their addresses, measure coord error vs truth — the honest-eval pattern at street
grain. **Open questions:** odd/even side handling fidelity in TIGER; ZIP+4-assisted snapping
(needs #525's ZCTA work as a prior); whether interpolation lives in `resolver-wof-sqlite` or a
new `@mailwoman/resolver-interpolation` workspace (lean: new workspace — different data
lifecycle, the slim/fat split the demo taught).

## Sequencing recommendation

#484 first (one agent-night of assembly against existing machinery, immediate demo value:
click-the-map), then #483 (data pipeline + new tier, 2–3 agent-nights). Both behind the v0.5.0
rebuild ONLY for the ZCTA prior — neither needs the char-offset format, so they can run in
parallel with it on the calendar.
