# Inferential resolution — constraint propagation when retrieval misses

Operator design note, 2026-08-08. Captured from a conversation immediately after the first-pass
Pelias benchmark; the failure-mode analysis in `FIRST_PASS.md` is the evidence that motivates it.
This is a design record, not a plan of record — nothing here is scheduled.

## The idea in one paragraph

When a parsed component does not resolve, the miss still carries information. Today we discard it:
an unmatched street falls back to the locality centroid and the reason is gone. The proposal is to
treat every unresolved component as a **constraint** rather than a null — narrowing where the thing
can be, even when nothing can say where it is — and to report the resulting answer with its
**derivation** attached, so a retrieved coordinate and an inferred region are never confused for
one another.

## Why now

The benchmark measured our failure shape precisely. Our misses are bimodal: either 0.01 km or
10,000 km, with very little between. Every catastrophic row was a country-scope failure, not a
parse failure — the model read `Favona`, `Maylands WA` and `Mulda` correctly and the resolver then
chose a same-named place on another continent. Pelias fails differently: its misses cluster in the
hundreds-to-few-thousand km range, because full-text ranking degrades into plausible-but-wrong.

Obviously-wrong is the better failure mode for a user to catch. It is also a symptom of throwing
information away: a system that knew "this street is not any street we hold in this locality" would
not have crossed an ocean. The constraint that was already in hand went unused.

## Four sources of constraint

1. **Hierarchical narrowing.** Resolved ancestors bound the search space for unresolved children.
   We partially do this; it is the least novel piece.

2. **Negative evidence.** An unknown street inside a locality whose street set we hold _completely_
   is known **not to be** any of them. That is categorically different from "no match", and today
   both produce the same null. Requires the coverage register to state completeness per locality —
   the meaning-of-zero rule (`docs/engineering/reference/the-meaning-of-zero.mdx`) already
   establishes that a magnitude never carries its own absence, which is exactly the distinction
   this depends on.

3. **Structural affinity.** Naming schemes are real and mineable. A neighborhood whose streets are
   all US presidents admits an unknown `Garfield Ave` on family membership, not string similarity.
   The same shape generalizes: an unknown hydronym against known hydrology, an unknown toponym
   against a region's morphology (the `-ton`/`-by`/`-thorpe` families in GB, `-ville` in FR).
   The identification is by structure-preserving relationship, not by label — the operator's
   category-theory framing.

4. **Physical plausibility.** Terrain, development and habitability act as exclusion. An address
   cannot be mid-cliff or mid-playa; a river cannot follow a ridgeline. Elevation, slope, land
   cover and built-up density each remove candidate area.

## Provenance is what makes this safe

The hazard is stated plainly: this inverts our failure mode. Today we fail at 10,000 km and the
user notices. An inference engine fails at 2 km and the user does not — which is the Pelias failure
mode we just called worse.

The resolution is to make the derivation part of the answer. A result carries not only a coordinate
and an uncertainty, but **how the granularity was reached**:

- `retrieved` — a gazetteer row matched; this is what every tier does today.
- `interpolated` — existing address-range interpolation.
- `inferred` — no row matched; the region is the intersection of stated constraints, each named.

An inferred result should name its constraints and their contribution, e.g. _locality resolved
(retrieved) → street unknown but excluded against 1,412 held streets (negative evidence, coverage
complete) → naming-family affinity to the presidents block (p=0.7) → slope/land-cover exclusion →
2.1 km² region, centroid reported with 1.4 km uncertainty_.

This is the best-of-both-worlds the operator asked for: the precision of inference with the
legibility of the obvious failure. It also fits the existing calibration and attribution work
rather than fighting it — `resolution_tier`, `uncertainty_m` and per-node `source` already exist.

## Central place theory, grounded

Interpolation is the primitive version of this idea, limited to address ranges along a segment, and
weak. The operator's extension: use settlement theory to get a prior over **existence and density**
for things we hold no record of.

Christaller's central place theory gives _threshold_ (minimum population sustaining a good) and
_range_ (maximum distance travelled for it). The prediction: a settlement of a given size supports
approximately N of a facility class, spatially distributed across its service area. So a query for
a grocery store in a suburb where we hold no POI row is not unanswerable — density and settlement
size say roughly how many exist and roughly where they concentrate (arterial roads, commercial
zoning), which is a bounded region with a stated basis.

The theory is 1933 and its assumptions (isotropic plain, rational consumers) do not survive contact
with real terrain. What makes this tractable now is that the parameters can be **measured rather
than assumed**:

- **US Census** — population, density, urban/rural classification, housing units, commute flows.
  The `tiger/` workspace already ingests TIGER/Line; the demographic tables are the same source
  family.
- **TIGER** — roads, blocks, block groups: the skeleton facilities distribute along.
- **BDC** (`bdc/`) — broadband availability as a development proxy, already ingested.
- **Overture/POI** (`poi.db`, 13.68M rows) — the observed density that _calibrates_ the predicted
  density. This is the honest move: fit the threshold/range parameters against places where we DO
  hold POI coverage, then apply them where we do not, and report the residual.

That last point is what separates this from numerology. CPT supplies the functional form; poi.db
supplies the fit; the fit's error on held-out regions is the confidence attached to any inference.

## Precompute

The relationships should be mined ahead of time, not derived per query — the resolver ladder is
synchronous and per-keystroke. Naming families, per-locality street-set completeness, terrain
exclusion masks and fitted CPT parameters are all build-time artifacts keyed to the existing H3/WOF
spine. This is the same pattern as the candidate table and the postcode bins, and it belongs to
the targeted-precompute lever already filed as
[#1549](https://github.com/sister-software/mailwoman/issues/1549) — with the caution recorded there
intact: precompute freezes a query distribution, so only stable and hot query classes earn an
artifact.

## The unifying thesis — physical constraint as claim verification

Operator addition, same session. The FCC broadband work (`bdc/`, `filer/`) is not adjacent to this
idea; it is the same idea already in production on a different claim type.

Its central thesis: carriers submit availability claims they often cannot substantiate, and
**physical plant determines what is possible**. A fiber claim at a location implies a fiber hut
within reach, poles or conduit along the route, and a serving terminal. Absent that plant, the
claim is not merely unverified — it is physically implausible, and the implausibility is
measurable. That is constraint-based verification of a claim against the built world.

The geocoding case is the same shape with the claim swapped:

|         | Claim                                | Physical constraint                         | Verdict                         |
| ------- | ------------------------------------ | ------------------------------------------- | ------------------------------- |
| BDC     | "we serve this location with fiber"  | fiber hut / pole route / terminal reach     | implausible if no plant         |
| Geocode | "this address is at this coordinate" | development, road class, terrain, utilities | implausible if no built context |

One mechanism, two applications. Which means the machinery is not speculative in the way the rest
of this record is — a version of it is already ingested, provenanced and `asOf`-scoped.

**Constraint sources this opens**, beyond the four above:

- **Road weightage.** TIGER MTFCC already classifies arterial / collector / local / private. An
  address on a named arterial sits in a different plausibility class than one on an unclassified
  track. Present in `tiger/` today, unused as a prior.
- **Utility plant.** Poles, conduit, substations, transmission corridors, antennas, data centers.
  Their presence bounds where habitation and commerce can be; their absence excludes.
- **Generation capacity.** Power plants and their output cap the development a region can sustain —
  a coarse prior, but a hard ceiling rather than a guess.
- **Hydrography.** Shorelines make a beach possible in exactly one adjacency class; water polygons
  are cheap exclusion for everything else. Census/NOAA water layers, already public.
- **Historical weather.** Less useful for placing an address, more for the habitability prior that
  underwrites the whole exclusion argument.
- **Economic output.** GDP and claimed production by country / state / city, worked backwards: a
  jurisdiction producing N of a good has M facilities producing it, somewhere inside its bounds.
  The most speculative source here and the one with the widest expected residual — but the
  direction is sound, and it is the same fit-then-assert discipline as the CPT parameters.

**What this makes the product.** A geocoder answers _where is this string_. A system that carries
physical constraint and reports its derivation answers _where is this, how do we know, and is the
claim even possible_ — which is address intelligence rather than address lookup. The BDC
verification case is the proof that the second question has customers.

The caution from the provenance section applies with more force here, not less: an infrastructure
prior that quietly promotes a plausible-but-wrong coordinate is worse than no prior. Every
constraint must be named in the derivation, and every fitted relationship must carry the residual
it was fitted at.

## Cheap versus speculative

**Cheap, and useful on its own:**

- Provenance in the result shape (`retrieved` / `interpolated` / `inferred` + named constraints).
  Valuable even with zero inference implemented — it makes the current fallback ladder legible.
- Negative evidence, given a coverage register that states per-locality completeness.
- Hierarchical narrowing, mostly present.

**Speculative, needs a probe before any build:**

- Naming-family mining. Does the presidents-block pattern generalize past anecdote? Measure the
  proportion of localities with a detectable naming scheme before assuming it is a lever.
- CPT parameter fitting. The residual on held-out POI regions IS the experiment; if it is wide, the
  prior is too weak to act on.
- Terrain exclusion. How much candidate area does slope/land-cover actually remove in the places
  where we miss? Possibly a great deal in mountainous terrain and almost none on a coastal plain.

## Falsifiers to run before building anything

1. **Does negative evidence change any answer?** Take the benchmark's missed rows, apply "not any
   street we hold in this locality", and count how many candidate sets shrink usefully. If few, the
   coverage register is not complete enough for this to bite yet.
2. **Do naming families exist at measurable rates?** Sample localities from the situs data and test
   for schemes (presidents, trees, states, numbered grids). A low hit rate kills source 3.
3. **Does CPT fit our own POI data?** Fit threshold/range against poi.db in covered metros, predict
   held-out metros, report error. A wide residual kills the density prior.
4. **Does inference beat the current fallback on the benchmark panel?** Re-score the panel with
   inference on and off. The bar is the strata table, not a pooled headline.

## Prohibitions

- **Never emit an inferred point as though retrieved.** Provenance is mandatory, not optional
  decoration.
- **Positive evidence only, soft priors.** Registries and theory nudge ranking; they never hard-gate
  a candidate out (`registry-backed-structured-prediction` doctrine).
- **A bounded region with stated confidence, never a fabricated coordinate.** If the honest output
  is a 40 km² polygon, that is the output.
- **Fit before assert.** No CPT parameter ships without its residual measured against held-out POI
  coverage.
