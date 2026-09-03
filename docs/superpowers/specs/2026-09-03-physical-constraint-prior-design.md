# Physical constraint as a generative prior — design record for #1975

Status: design record, the first item of #1975's definition of done. Nothing in this record changes
runtime behavior. It fixes where the prior sits, what it may express, what it must never be, what
every exclusion carries, and how the GB prototype is built and graded.

## 1. Inputs this record consumes

| Input                                         | Result                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1684 experiment 3 (GHSL habitability mask)   | NO-GO on the pre-registered rule: the only mask with a clean control excludes 7 of 46 FIRST_PASS tail rows and 0 of 5 on the current tail; the mask with power also excludes 50 of 420 truth points, which are rural rooftops. A habitability mask does not earn a place as a candidate filter. Recorded on #1975.                            |
| License position (operator, 2026-09-03)       | Exploration and validation of these inputs are free. Packages ship separately, so a customer chooses which data-license posture to engage with; `mailwoman doctor` reports the posture of every attached layer (PR #2117). Counsel review stays the condition for shipping beyond `build-local`.                                              |
| #1571 (inferential resolution)                | Physical plausibility is its fourth constraint source. Its prohibitions bind here: positive evidence only, soft priors, never an inferred point served as retrieved, a bounded region with stated confidence rather than a fabricated coordinate.                                                                                             |
| Exclusion-grade coverage (PR #1973)           | `supportsExclusion` is true only for `basis = designated` or `surveyed`. `source_present` supports presence and nothing else. A cell with no footprint data is not a cell excluded by physics.                                                                                                                                                |
| Geographic-model boundary (2026-08-26 record) | No ranking weight, boost, penalty, or candidate order may be authored by a world-model record. First production integration of any world fact is diagnostic and observational only.                                                                                                                                                           |
| Postcode-structure arc (2026-08-05 plan)      | Code-Point Open carries 1,746,976 unit postcodes and zero `BT` (Northern Ireland) units. Its M-2b note cites an NI "census file"; that file is the OSM Overpass acquisition described in section 7, and the 4,758 it counted included one malformed row. GB unit postcodes already build `postcode-gb.bin` and the outward-district ancestry. |

## 2. What the prior is, stated precisely

The GB granularity gap is an assignment problem. Code-Point Open gives one coordinate per unit
postcode. OS Open UPRN gives one coordinate per addressable object: 41,629,393 points, GB only. The
register that says which UPRN carries which unit postcode is the licensed product's content. The
prior is a generative model of that register from open inputs: given the unit-postcode centroids,
the UPRN points, and the buildings they sit in, assign each point to a unit postcode, and say for
each assignment how it was reached.

Two consequences follow, and both narrow the design.

**The prior is a build-time product, not a runtime scorer.** The assignment is computed once from
sealed inputs into a sealed artifact, `postcode-unit-assignment-gb.db`, with a `layer_manifest` and
per-row provenance. At runtime the resolver reads it as a lookup: a unit postcode resolves to the set
of points assigned to it, or to their bound. No runtime component reasons about buildings. This is
the same shape as `poi.db`, `uprn.db` and the postcode binaries: the intelligence lives in the
builder, the runtime consumes a register.

**There is an open register, and it answers the GB assignment directly.** The ONS National
Statistics UPRN Lookup (NSUL) publishes, for every GB UPRN in AddressBase, the unit postcode as field
`PCDS` (null when the postcode is not in Code-Point Open), the OSGB grid reference, and the
statistical geographies, as a CSV collection of about 487 MB, every six weeks, under OGL-UK-3.0 with
four attribution lines (section 8). Falsifier F1 is therefore answered, and it reshapes the
prototype:

- For GB, the open UPRN → unit postcode register exists. The shippable artifact is a sealed build of
  NSUL joined to Open UPRN's coordinates, not a generative reconstruction of it.
- The generative method is graded against NSUL as a measurement of how much of the register
  physical inputs alone recover. That number is what Northern Ireland needs, where neither Open UPRN
  nor NSUL exists, and it is the only place the method's error can be measured.
- NSUL's postcodes are those of Code-Point Open, so the two inputs agree by construction on the
  universe of unit postcodes; the grade's denominator is UPRNs present in both.

## 3. Placement in the pipeline

Candidate shaping happens between candidate lookup and ordering. The `PlaceLookup` backend
(`@mailwoman/resolver-wof-sqlite`) returns candidates; `@mailwoman/resolver` decorates the tree and
then orders through `span-rescore.ts` and `rankByImportance` in `toponym-prior.ts`. The prior's
runtime surface is a decoration step that runs on the decorated tree BEFORE any ordering, and it
touches exactly two things:

1. The candidate SET, by hard exclusion, only where section 5 permits it.
2. The result's derivation, by attaching a bounded region and its provenance where the walk resolved
   nothing finer than the unit postcode.

It never touches `rankByImportance`, the span-rescore weights, the country prior, the
placetype-pair prior, or any decode-time term in `@mailwoman/neural`. `plausibility.ts`, the
post-resolve guard for country-centroid answers, stays as it is; this prior runs earlier and answers
a different question.

For the first deliverable the runtime surface is not built at all. The artifact and its grade come
first, per #1571's rule that measurement precedes mechanism.

## 4. What the prior may express

- **Hard physical exclusion.** A candidate coordinate that falls in a cell the assignment artifact
  covers at exclusion grade and that carries no addressable object can be removed from the
  candidate set. The exclusion names the cell, the basis, and the artifact version.
- **Soft possibility structure.** For a unit postcode, the assigned points and their bound: the H3
  res-9 cells the assigned points occupy, and the count of points. This is a region with a
  completeness statement, never a single point presented as the postcode's location.
- **The assignment itself**, per UPRN: the unit postcode, the rule that produced it (section 6), and
  its confidence class — `unique`, `tie`, or `unassigned`.

## 5. What the prior must never be, and what every exclusion carries

Never:

- an authored ranking weight, boost, penalty, or candidate order (the geographic-model line);
- a default-path change without the D-rule's grade on every tier-1 locale and the eval bar;
- an inferred point served as `retrieved` (#1571);
- an exclusion from a cell whose coverage basis is `source_present`;
- a guess for a point the rules leave `unassigned`.

Every exclusion carries: the artifact name and version, the H3 cell, the coverage basis that licensed
it, and the derivation kind `inferred`. Every result the prior touched carries the derivation kind in
its provenance, so a caller can tell a retrieved rooftop from an inferred bound without reading a
distance.

## 6. The GB prototype — one postcode area, open data only

**Area.** The `PO` postcode area (Portsmouth, Chichester, Bognor Regis, the Isle of Wight). It mixes
dense terraces, suburbs, rural parishes and an island, and the board already carries a `PO21` row
(`University of Chichester, The Dome, Upper Bognor Rd, Bognor Regis PO21 1HR, United Kingdom`), so
the prototype's output can be read against a row the resolver is graded on today. Counts of unit
postcodes and UPRNs in `PO` are filled by the run, with the arithmetic stated.

**Inputs on disk.**

| Input                     | Artifact                                                                | Rows                                        | License                                                      |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Unit postcode centroids   | `$MAILWOMAN_DATA_ROOT/wof/postalcode-gb-codepoint.db` (Code-Point Open) | 1,746,976 (`spr`)                           | OGL-UK-3.0                                                   |
| Addressable-object points | `$MAILWOMAN_DATA_ROOT/uprn/uprn.db` (OS Open UPRN, release 2026-08)     | 41,629,393; coverage `designated` 1.0       | OGL-UK-3.0 (manifest)                                        |
| Building footprints       | none on disk                                                            | —                                           | OS Open Map – Local `Building` layer, OGL-UK-3.0, to acquire |
| Truth for grading         | none on disk; ~487 MB CSV collection to acquire                         | one row per GB UPRN, `PCDS` = unit postcode | ONS NSUL, OGL-UK-3.0 (F1 answered)                           |

OSM buildings (ODbL) are excluded from the GB prototype on purpose, so the GB artifact's posture is
OGL throughout. They return in section 7, where no OGL footprint source exists.

**Method, in three rules applied in order, each recorded on the row it decides.**

1. `nearest-centroid` — the null model. Each UPRN takes the unit postcode of the nearest Code-Point
   centroid. This is the baseline every richer rule must beat.
2. `same-building` — points inside one building footprint take one postcode: the postcode that the
   majority of the building's points took under rule 1, with ties left as `tie`.
3. `unassigned` — a point farther than a distance bound from every centroid, or inside a building whose
   points split evenly, stays unassigned. The bound is set from the observed distribution of
   nearest-centroid distances in the area and stated in the artifact's meta.

**Grade.** Against NSUL for the same UPRNs: exact-assignment rate, `tie` rate, `unassigned` rate,
and the confusion between adjacent unit postcodes, each with its denominator (UPRNs in `PO` present in
both inputs). The null model is graded first, then the two-rule model, and the difference is the
footprint input's measured contribution.

**Pre-registered rule.** If rule 2 does not lift exact assignment by at least 5 percentage points
over rule 1 on `PO`, the footprint input is dropped from the design and the artifact is the null model
with its measured error. If the null model itself is under 80% exact, the assignment does not earn a
runtime surface at any tier and the artifact stays a measurement.

## 7. Northern Ireland — the hard test

Amended after the run (record `docs/records/evals/2026-09-03-ni-unit-postcode-assignment.md`, PR
#2125). Code-Point Open has zero `BT` units; Open UPRN is GB only; NSUL excludes `BT`; the NI register
(Pointer) is licensed and not used. The one open BT postcode geometry we hold is not a census product:
it is the Overpass acquisition `osm-ni-postcodes/2026-08-05/response.json` (ODbL, `build-local`),
12,326 OSM elements carrying `addr:postcode` starting `BT`, from which `wof/postalcode-ni-osm.db`
stores one medoid per unit — 4,757 units, 250 sectors, 80 districts. Those elements are also the only
openly attested BT points, so centroid and truth are the same observations and an independent-input
test cannot be run in Northern Ireland from open data.

What could be measured is the attestation's internal consistency, leave-one-out nearest centroid:
7,222 of 12,326 points exact (58.6%) over all points, 7,222 of 9,326 (77.4%) over points whose unit
keeps a centroid after removal (3,000 units are singletons). Both are under the 80% floor. The
method's register error stays the GB figure, 69.6% exact against NSUL on `PO`; a measurable NI test
needs the licensed register.

## 8. License posture per input

| Input                         | License                | Obligation summary       | Posture for the prototype                                    |
| ----------------------------- | ---------------------- | ------------------------ | ------------------------------------------------------------ |
| Code-Point Open               | OGL-UK-3.0             | attribution              | already built and shipped in `postcode-gb.bin`               |
| OS Open UPRN                  | OGL-UK-3.0             | attribution              | built, `build-local`; counsel review before shipping         |
| OS Open Map – Local buildings | OGL-UK-3.0             | attribution              | to acquire; same review                                      |
| ONS NSUL                      | OGL-UK-3.0 (confirmed) | attribution (four lines) | the GB register itself, once counsel reviews the attribution |
| OSM buildings (NI only)       | ODbL-1.0               | attribution, share-alike | `build-local`; the same posture `packages/osm` holds         |

The doctor summarizes each of these from the artifact's own `layer_manifest` once built, so the
posture is data in the artifact, not prose here.

## 9. Falsifiers, in order

- **F1.** Answered 2026-09-03: NSUL is published under OGL-UK-3.0, GB coverage, six-weekly, and each
  row carries `PCDS`, the unit postcode from Code-Point Open. The user guide (May 2025, Epoch 118)
  requires four attribution statements: `Contains OS data © Crown copyright and database right
[year]`, `Contains Royal Mail data © Royal Mail copyright and Database right [year]`, `Contains
GeoPlace data © Local Government Information House Limited copyright and database right [year]`,
  and `Source: Office for National Statistics licensed under the Open Government Licence v.3.0`.
  Northern Ireland (`BT`) postcode data is excluded from the open terms and needs a separate
  Land & Property Services license, which the NI section already assumed.
- **F2.** The null model on `PO`: exact-assignment rate against NSUL. Below 80%, stop.
- **F3.** The footprint rule lifts exact assignment by at least 5 pp over F2. Otherwise drop the
  footprint input.
- **F4.** Only after F2 and F3: the runtime decoration step, graded on the full board and every
  conformance suite with the D-rule, as an opt-in pin first.

## 10. Sequencing

1. This record (done).
2. F1: read NSUL's license page and one quarterly file's header; record on #1975.
3. Acquire OS Open Map – Local for `PO`; build the assignment artifact with the three rules and
   per-row provenance; grade F2 and F3; record on #1975 with denominators.
4. The NI run as section 7, recorded whichever way it comes out.
5. Counsel review of section 8 before any artifact leaves `build-local`.
6. F4, as a separate proposal with its own board grade.
