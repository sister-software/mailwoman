# Ablation expectation model

The gauntlet's ablation layer asks what deleting one component is honestly allowed to cost. It does not grade every
variant against the undeleted rooftop: removing a country may leave enough evidence to hold that rooftop, while removing
street and house number should coarsen to an administrative centroid, and a bare ambiguous name may need to abstain.

## Ladder construction

Each case gets a resolution ladder. Rung 0 is the row's asserted coordinate and tolerance. Later rungs are the
administrative chain containing that coordinate, ordered from locality through country. The final rung is abstention.
The chain comes from the asserted coordinate rather than the parser's answer, avoiding circular grading when the base
answer itself is wrong. Rows without asserted coordinates may use the undeleted pipeline answer, but record that weaker
anchor source explicitly.

Every rung has a radius. Degenerate WOF bounding boxes mean “extent unavailable,” not radius zero: this affects 59.1% of
countries, 39.3% of regions, 49.2% of localities, and 86.2% of neighbourhoods in the measured artifact. Non-degenerate
boxes can also contain rounding noise, so `RUNG_RADIUS_FLOOR_KM` applies the measured placetype floor.

## Expected rung

`deriveExpectedRung` reads only the components left after deletion and the gazetteer. It never reads the variant's output.
The evidence cascade is:

1. A unique remaining postcode pins its place.
2. A decisive remaining locality-like name pins its top constrained candidate.
3. Otherwise a remaining region or country pins that administrative rung.
4. With no indexed evidence, the model abstains or marks the case unconstrained.

If the pinned place is the base ladder's deepest administrative rung and house-grade or venue evidence survives, rung 0
must hold. A decisive homonym outside the base ladder is a takeover and expects abstention rather than accepting a point
on the wrong hierarchy.

Grading starts at the undeleted result's achieved rung. This anchor floor ensures the deletion is charged only for the
degradation it caused, not for a miss already present in the base case.

## Decisiveness

Candidates within `COINCIDENT_PLACE_KM` collapse before comparing rank, because WOF can represent one physical city at
multiple placetypes. A remaining name is decisive when only one distinct place remains or when the population-rank margin
is at least `DECISIVE_MARGIN_LOG10` (0.5 log10, roughly 3.2×). The 0.5 threshold was selected from the coordinate-backed
gauntlet rows: above the reduce, the top candidate matched the asserted place in 89.1% of decisive rows; below it, the
ambiguous group was effectively a coin flip.
