# `@mailwoman/opportunity-map`

The data model of the building and shared-route opportunity map in
[#2289](https://github.com/sister-software/mailwoman/issues/2289). It reads a dossier from
`@mailwoman/dossier` and a scenario from `@mailwoman/route-scenarios`, and it returns GeoJSON feature
collections at building, route and district scales as plain objects. The workspace imports no map library,
and the private application in `packages/opportunity-app` draws these collections. It is private, and this
repository holds synthetic economic inputs only.

## The building scale

`buildingFeatures` returns one feature per dossier building. The caller chooses the unit stage whose total
is each building's denominator. These rules decide each building's state in order, and the first rule
that matches decides it:

1. `unknown_unit_count`: the unit total is unresolved.
2. `zero_premises`: the unit total resolves to 0.
3. `partial_availability`: a provider is recorded as available on the dossier date, or the latest readings
   of one of the building's checks hold records. A dossier records availability for a building or its
   extent, and no record establishes service to every unit, so no state claims a fully served building.
4. `known_unserved`: the building has a check, the latest readings of every check establish absence with
   a `surveyed` or `designated` zero, and no provider is recorded as available.
5. `unknown_coverage`: the rules above place the building in no other state.

A feature's properties state the rule's reason with the building's values, the unit denominator as a
number or the word `unresolved`, and the source records behind the state. The units, the service evidence
and the access records are separate groups, and a building feature carries no economic figure. The
geometry is a point at the building's resolved position. It is `null` when the dossier has no position for
the building or when two positions differ, and the properties then list the positions that differ. A
synthetic position is labeled synthetic.

The service evidence lists each provider available on the dossier date once for each extent that the
records current on that date state, with the extent as data. A reason states a provider with an extent as
available over that extent, because the record does not say which premises in the extent are served. A
record without an extent states availability for the building, and its reason reads as available.

## The district scale

`districtFeatures` clusters buildings by an extent kind the caller chooses. An extent's kind is its text
before the first colon, so `census-tract:36047050401` has the kind `census-tract`. A building joins the
cluster of its extent when exactly one admitted membership of the kind places it. The buildings with no
such membership form one `unplaced` feature, and the buildings with two or more form one `ambiguous`
feature. Each building is therefore counted once.

A district feature reports the sum of resolved unit totals, the count of buildings whose total is
unresolved, and the count of buildings in each state. An unresolved total never enters the sum as a zero.
The district features add up to the building scale's building count, resolved units, unresolved totals
and states. A feature's geometry is a `MultiPoint` of its buildings' resolved positions.

## The route scale

`routeFeatures` returns one line for each route segment a selection uses. `@mailwoman/route-scenarios`
prices segments without geometry, so each segment's path and basis arrive as a `SegmentPath` beside the
scenario. A segment is `verified` when its basis is a source record that the dossier admitted, and
`proposed` when its basis is an operator assumption. A segment that more than one selected building uses
is `shared`. Each segment's amount is the cost that `constructionCost` charges for it once in the
selection.

## Selections and portfolios

`selectionEconomics` recalculates a selection through `prepareScenario` and `projectCashFlow` in
`@mailwoman/route-scenarios`: eligible units, construction cost, NPV, first revenue and funding. The model
never adds standalone building estimates, because each building's own estimate would charge a shared
segment once per building. A selected building with an unresolved unit total throws
`UnresolvedUnitTotalError` there, and no figure is computed for the selection.

`portfolioTotals` sums projects drawn from one scenario, each a selection of buildings. It accepts only
projects that share no building and no segment. Otherwise `OverlappingProjectsError` lists each
overlapping pair of projects with the buildings and segments the pair shares. Every figure is labeled
synthetic when the scenario's inputs are synthetic.

## Modules

| Module                    | Contents                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ |
| `lib/inputs.ts`           | `MapInputError` and the check of a line's coordinates                          |
| `lib/buildings.ts`        | The five states, their rules, the unit denominator and `buildingFeatures`      |
| `lib/districts.ts`        | `districtFeatures` and the unplaced and ambiguous features                     |
| `lib/routes.ts`           | `SegmentPath`, the verified, proposed and shared segments, and `routeFeatures` |
| `lib/selection.ts`        | `selectionEconomics`, `portfolioTotals` and `OverlappingProjectsError`         |
| `lib/example-district.ts` | The synthetic Example District's records, scenario and segment paths           |

`lib/example-district.ts` holds the synthetic Example District: seven fictional buildings in the five
states, two districts, a proposed trench shared by two buildings and an existing duct that a synthetic
plant record verifies. Its coordinates lie in the open South Atlantic, where no building stands. The
workspace's tests import it as `#example-district`, and the application in `packages/opportunity-app`
imports it as `@mailwoman/opportunity-map/example-district`. The package's root entry leaves it out.

The fixture `test/fixtures/london-three-buildings.ts` holds three London residential buildings as one
dossier dated 2026-10-05, built from the public records that
`docs/records/research/2026-10-05-uk-three-building-competition-sources.md` lists. Each position is a
planning row's grid reference converted with `osgb36ToWGS84`. The fixture holds no availability check and
no provider record, so each building's state follows from its planned unit total. 28-30 Addiscombe Grove
and 112-132 Cricklewood Lane are in `unknown_coverage`. 130-154, 154a Pentonville Road is in
`unknown_unit_count`, because its planning row states 119 planned units and its GLA referral states 118.
Ofcom's area figures are inferred claims and decide no state. `london-three-buildings.full.test.ts`
recomputes the fixture's flood readings from the host's `flood.db` and skips when the database is absent.

## Limits

- A route segment's path is supplied beside the scenario. The model draws no route from proximity.
- A portfolio compares segments by their identifiers in one scenario.
