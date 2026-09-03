# Unit-postcode assignment in Northern Ireland: what open inputs can and cannot measure

Date: 2026-09-03. Record for #1975, section 7 of the design record
`docs/superpowers/specs/2026-09-03-physical-constraint-prior-design.md` — the Northern Ireland run,
recorded whichever way it came out. Companion to the GB record
`2026-09-03-po-unit-postcode-assignment.md`. Point-in-time; numbers are not updated. Pre-registration:
the #1975 comment "Northern Ireland run — pre-registration", posted before the script ran.

## Question

Section 7 asks whether the nearest-centroid assignment measured on the `PO` area (69.6% exact against
NSUL) can be run and graded in Northern Ireland, where there is no Open UPRN and no NSUL. Two things
had to be found first: what geometry the BT unit postcodes on the data root carry, and which openly
attested BT points exist to grade against.

## Inputs, and what they turned out to be

| Input                                    | Artifact                                                                                                                | Rows in play                                                          | Provenance                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| BT unit postcodes ("the NI census file") | `$MAILWOMAN_DATA_ROOT/osm-ni-postcodes/2026-08-05/response.json` — an Overpass acquisition, not a NISRA product         | 12,327 elements (2,752 nodes, 9,458 ways, 117 relations); 4,757 units | query `nwr["addr:postcode"~"^BT"]`, `out center`; 6,681,108 bytes, md5 `e24adcee6b3dcd23688332f8f9d47a1c`; ODbL 1.0; tier `build-local`       |
| Built unit-postcode artifact             | `$MAILWOMAN_DATA_ROOT/wof/postalcode-ni-osm.db` (`mailwoman gazetteer build postcode-ni-osm`)                           | 4,757 rows, one medoid point per unit                                 | built from the acquisition above; the reader is `ni-osm-database.ts`                                                                          |
| Attested BT points (truth)               | the same 12,327 elements: each carries `addr:postcode` and a coordinate                                                 | 12,326 after 1 malformed value (`BT36 4RU,`); 0 without a coordinate  | as above                                                                                                                                      |
| Second path for the point count          | `$MAILWOMAN_DATA_ROOT/osm/geofabrik/ireland-and-northern-ireland-latest.osm.pbf` (2026-07-05 snapshot), GDAL OSM driver | 12,292 rows with `addr:postcode LIKE 'BT%'`, 4,743 distinct units     | md5 `2e65f8e36046c914cbaf947528d90f9a`; ODbL 1.0                                                                                              |
| Open UPRN-equivalent for NI              | none                                                                                                                    | —                                                                     | Pointer (LPS) is licensed; ONSPD/NSPL carve BT out of OGL; NSUL excludes BT; Code-Point Open has zero BT units (its own meta records the gap) |
| Buildings                                | not run                                                                                                                 | —                                                                     | OSM footprints are in the same PBF; the GB footprint rule lifted exact assignment by −0.06 pp, so they were not spent here                    |

**Geometry grade.** Every BT unit postcode we hold is a unit-grade point, but it is the medoid of the
OpenStreetMap elements that are themselves the only openly attested BT points. The centroid source and
the truth source are one file. The postcode-structure plan's M-2b (`docs/superpowers/plans/2026-08-05-postcode-structure-arc.md`)
called this file "the NI census file" with "no coordinates"; the coordinates were dropped in the CSV
that plan read, not absent from the acquisition, and "census" there meant a census of OSM tags.

**Consequence before any number.** The test section 7 describes — an independent centroid source graded
against attested points — cannot be run from open NI inputs. Unit-grade exact assignment from
independent open inputs is UNMEASURABLE in Northern Ireland. What can be run is the leave-one-out
version below, which measures the internal consistency of the OSM attestation and nothing about the
register.

**Coverage of the truth.** 4,757 attested units of 50,032 live NI postcodes (9.5%, the figure baked
into the built artifact's meta). 3,000 of the 4,757 units have exactly one attested point; 9,326 of the
12,326 points sit in a unit with two or more. 6,877 of 12,326 elements carry a `name` (venues rather
than dwellings); 1,321 cite `source:addr = FHRS Open Data`; BT52 alone holds 1,246 points (10.1%).
The second path agrees with the primary count within 0.3% (12,292 rows and 4,743 units from a
snapshot one month older, read by a different tool).

## Method

1. `leave-one-out nearest-centroid` — for each attested point, remove it, recompute its own unit's
   centroid from the remaining members (the unit has no centroid when the point was its only member),
   and assign the point to the nearest centroid of any of the 4,757 units. Primary centroid: the mean of
   the remaining members; secondary: their medoid, which is what the built artifact stores.
2. Grade exact unit; wrong unit in the same sector; wrong sector in the same district; wrong district.
   Recall at k for k = 1..5 over unit centroids; distance to the assigned centroid; ties within 1 m.
3. `in-sample` — the same assignment with no point removed. Optimistic by construction (a point's own
   unit centroid is pulled toward it); reported as section 7's internal-consistency figure only.

Two denominators: all 12,326 points, and the 9,326 points whose unit keeps a centroid after the point
is removed (the recoverable set). The 3,000 singleton points are misses by construction on the first
denominator, so its ceiling is 75.7%.

## Results

Primary (mean centroid):

| Denominator                        | Exact            | Rate   | Wrong unit, same sector | Wrong sector, same district | Wrong district | Ties (< 1 m) |
| ---------------------------------- | ---------------- | ------ | ----------------------- | --------------------------- | -------------- | ------------ |
| leave-one-out, all points          | 7,222 of 12,326  | 58.59% | 4,453 (36.1%)           | 424 (3.4%)                  | 227 (1.8%)     | 138 (1.1%)   |
| leave-one-out, recoverable set     | 7,222 of 9,326   | 77.44% | 1,912 (20.5%)           | 129 (1.4%)                  | 63 (0.7%)      | 109 (1.2%)   |
| in-sample (no removal; optimistic) | 10,697 of 12,326 | 86.78% | 1,501 (12.2%)           | 84 (0.7%)                   | 44 (0.4%)      | 82 (0.7%)    |

Secondary (medoid centroid): 7,171 of 12,326 (58.18%) on all points; 7,171 of 9,326 (76.89%) on the
recoverable set; 10,689 of 12,326 (86.72%) in-sample. The two centroid rules differ by half a point.

Distance to the assigned centroid, leave-one-out: all points p50 61 m, p90 334 m, p99 2,268 m, max
7,069 m; recoverable set p50 48 m, p90 168 m, p99 556 m. Recall at k over the 9,326 recoverable points:
77.44% at 1, 89.65% at 2, 93.56% at 3, 96.23% at 4, 97.19% at 5 (medoid: 76.89 / 89.20 / 93.24 /
95.98 / 97.00). For a miss whose true unit kept a centroid (2,104 points), the true centroid is 1.64×
farther than the nearest at the median and 4.54× at p90.

Worst districts on the recoverable set with at least 100 points: BT1 63.0% of 257; BT31 64.1% of 117;
BT7 65.6% of 186; BT33 66.0% of 100; BT48 67.5% of 114. Largest confusions: `BT19 6PH` → `BT19 6PT`
(46 points) and `BT19 6PH` → `BT19 6PQ` (44); `BT19 6PH` is a holiday park at Groomsport with 264
attested elements, and its two neighbors carry 6 and 23. A unit that large has a centroid far from its
own edge, and any small unit beside it wins those edge points.

## Verdict against the pre-registered rules

- **Unit-grade exact assignment from independent open NI inputs: UNMEASURABLE.** Decided by the input
  inventory, not by a number: the only open BT postcode geometry is derived from the only open BT
  truth points.
- **Recoverable set 77.44% exact:** inside the pre-registered 59.6–79.6% band, so the GB record's
  reading — about three points in ten wrong — transfers to what NI can measure. It sits above the
  pre-registered expectation of 50–70%; that expectation was wrong on the low side, for the reason given
  under Reading.
- **All points 58.59% exact:** above the pre-registered 35–55% expectation, for the same reason.
- **Below the 80% floor on both denominators.** No runtime surface for an NI assignment. The in-sample
  86.78% is over the floor and decides nothing; it was pre-registered as optimistic by construction.

## Reading

The recoverable-set rate (77.4%) is higher than the GB null model (69.6%), and the two are not the
same measurement. In GB every unit in the box has a Code-Point centroid, so each UPRN competes against
every real neighbor. In NI only 4,757 of 50,032 units have any point at all, so for most attested points
the true competitors are absent from the centroid set, and a point is graded against a field
about one-tenth as crowded. The recoverable set is further conditioned on units OSM mappers tagged twice
or more, which favors venues, retail parks and estates that were mapped as a batch (BT52's 1,246 points
are 10.1% of the file). Read 77.4% as "the OSM BT attestation is internally consistent to about three
points in four when a unit has more than one member", not as the method's error against the register;
the register's error is what the GB record measures, and that is the number section 7 should carry
forward for NI as well.

The distance distribution says the same thing from the other side: the leave-one-out p90 on all points
is 334 m against 72 m in GB, and p99 is 2,268 m against 278 m, because a singleton's nearest centroid is
some other unit's by construction.

## Consequences

1. **Section 7 of the design record needs amending** (not edited here). "4,758 BT unit postcodes as
   centroids derived from the census file" should read: 4,757 unit postcodes, each a medoid of OSM
   `addr:postcode` elements (ODbL, `build-local`), the same elements that are the only openly attested
   BT points — so the section's independent-input test is unmeasurable, and the leave-one-out figure
   here is its internal-consistency result. The count is 4,757, not 4,758: the plan's figure included
   the one malformed value.
2. **No NI assignment artifact is earned.** Both leave-one-out denominators are under the 80% floor, and
   a build-local NI artifact would in any case be the built `postalcode-ni-osm.db` restated, since the
   centroids and the points are one file.
3. **The way to a measurable NI test is a licensed input, not more computation.** Pointer (LPS) would
   supply both an independent truth and full-coverage unit points; until then the NI number to quote is
   the GB register-graded error, with the caveat that NI's centroids would be OSM medoids at 9.5%
   coverage.
4. **The postcode-structure plan's M-2b note is stale on two counts** ("census file", "no
   coordinates"); a one-line correction in a later pass of that plan, pointing at the acquisition
   directory, would stop the next reader from looking for a NISRA product.

## Reproduce

`scratchpad/1975-ni/f2ni-loo.ts` (`node f2ni-loo.ts mean`, `node f2ni-loo.ts medoid`; 25 s each, git-ignored scratch)
over `$MAILWOMAN_DATA_ROOT/osm-ni-postcodes/2026-08-05/response.json`. The second-path count is
`scratchpad/1975-ni/pbf-count.sh`: `ogr2ogr -f CSV … -sql "SELECT osm_id, hstore_get_value(other_tags,'addr:postcode') AS pc FROM <layer> WHERE hstore_get_value(other_tags,'addr:postcode') LIKE 'BT%'"`
over the `points`, `lines`, `multipolygons` and `other_relations` layers of the Geofabrik PBF.
