# Building dossier: interface inventory and first cases

This inventory completes the interface review for
[#2285](https://github.com/sister-software/mailwoman/issues/2285), under the building feasibility
application in [#2291](https://github.com/sister-software/mailwoman/issues/2291).
[#2455](https://github.com/sister-software/mailwoman/issues/2455) owns this document.
`@mailwoman/dossier` (`packages/dossier`) implements the data model and the eight cases below.
A layer reading with a `subject` attaches to that building. A reading without one attaches to each
building that an admitted membership record places in the reading's extent, and the dossier lists a
reading that neither rule places as unplaced. A membership record cites the source that places the
building in the extent ([#2477](https://github.com/sister-software/mailwoman/issues/2477), under
[#2289](https://github.com/sister-software/mailwoman/issues/2289)).

A dossier is a reviewable account of one property's identity, physical premises, network evidence,
access, engineering, available products and demand. Each conclusion identifies the records behind it
and the next investigation needed. A multi-dwelling unit building, abbreviated MDU, can contain many
units and several entrances.

## Observed interfaces

The inventory reads source at `09b58960a`. It establishes the interfaces available for reuse;
it does not measure their accuracy on the selected building.

| Module                                                                                    | What it supplies                                                                                                                                                                       | Consequence for the dossier                                                                                                                   |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`PostalAddress`](../../../packages/record/lib/address.ts)                                | Parsed components, a canonical match key, optional original text and a geocode with resolution tier and uncertainty. `AddressGeocode` distinguishes PO boxes and multi-unit buildings. | Preserve the input and geocode uncertainty when investigating identity. Shared coordinates cannot distinguish units.                          |
| [`PostalAddressID`](../../../packages/address-id/lib/index.ts)                            | A key composed of a region prefix, an H3 cell and a hash of normalized address text.                                                                                                   | Keep it as an address reference. Different aliases can produce different keys for the same building; a cell boundary can also change the key. |
| [`Observation` and `Relation`](../../../packages/evidence/lib/evidence.ts)                | Source, vintage, observed value, and whether a relationship is authoritative or inferred. An authoritative relation cannot carry a match score.                                        | Import these types from their owning package. Add explicit subject, source-record reference and time fields in the application record.        |
| [`EpistemicStatus`](../../../packages/evidence/lib/status.ts)                             | Distinct designated, observed, derived, inferred and unresolved states.                                                                                                                | Preserve how a value was established separately from its subject and business meaning.                                                        |
| [`CoverageBasis` and `requireExclusionBasis`](../../../packages/evidence/lib/coverage.ts) | Conditions under which a layer's coverage supports an exclusion.                                                                                                                       | Keep a missing reading distinct from a surveyed empty result, within the scope that the survey establishes.                                   |
| [`DerivationProjection`](../../../packages/evidence/lib/derivation.ts)                    | An answer's status, contributing evidence and uncertainty radius.                                                                                                                      | Reuse it when displaying geographic derivations. Record application calculations and their input references separately.                       |
| [`filer_node` and `filer_edge`](../../../packages/filer/lib/schema.ts)                    | Provider identifiers and dated, sourced relationships, including separate ownership and management relations.                                                                          | Reuse supported provider identities. A corporate relationship alone cannot establish permission to build at a property.                       |
| [`FilingLandscape`](../../../packages/bdc/lib/filing/landscape.ts)                        | Provider and technology groups counted by distinct block, plus surveyed and unknown block counts.                                                                                      | Label these results as block-level filing evidence. Their denominator cannot become buildings, residential units or subscribers.              |
| [`nearestInfrastructure`](../../../packages/bdc/lib/nearest-infrastructure.ts)            | Nearby infrastructure categories, distances and associated coverage readings.                                                                                                          | Present proximity as an observation. Capacity, connection topology and permission require their own records.                                  |
| [`SourceObservationRecord`](../../../packages/geographic-model/lib/schema.ts)             | A relation between two concept identifiers, with modality and provenance. The schema has no numeric fields.                                                                            | Keep reusable concept semantics here. Individual buildings, unit counts, prices and customer events need an application model.                |
| [Spatial-layer interface](../../engineering/reference/layer-interface.mdx)                | Artifact provenance, declared spatial keys, coverage and data tiers.                                                                                                                   | Read each layer at its declared resolution and vintage. Preserve its coverage limits in the dossier.                                          |

## Proposed minimum extension

The first implementation should validate and project supplied records without adding a database,
training a model or acquiring a new dataset. Choose its existing package home after checking the
consumer's dependency graph; this inventory does not establish a new workspace.

1. **Identify physical objects explicitly.** Represent a parcel, building, entrance and unit as
   distinct entities. Retain external identifiers with their issuing namespace. Use application IDs
   for unresolved objects, and preserve candidate matches rather than merging on proximity alone.
2. **Keep aliases and relationships sourced.** An alias points to a candidate entity through evidence.
   Entrance-to-building, unit-to-building and building-to-parcel relationships each carry their own
   source record, observation date and applicable validity interval. One parcel can contain several
   buildings. A postal alias can refer to more than one entrance.
3. **Store independent claims.** Each claim names its subject, predicate, typed value, evidence and
   applicable dates. Identity, physical premises, network, access, engineering, product, demand and
   evidence status remain separate. Preserve competing claims instead of overwriting one with another.
4. **Keep counts interpretable.** A count states its object kind, subject scope, date and source.
   Distinguish planned, completed and occupied units. A total is available only when membership and
   overlap are established. Otherwise return an unresolved total with the conflicting claims.
5. **Record commercial events separately.** Inquiry, commitment, order, active subscription, landlord
   permission and accepted build are distinct event types. Each event identifies its parties, physical
   scope and relevant dates. An ownership record does not establish signing authority.
6. **Make the next action inspectable.** Each proposed investigation identifies the unresolved claim and
   the evidence that would answer it. Present an observed blocker separately from a question awaiting
   investigation. Preserve construction windows and their dates without converting a planned window
   into an accepted build.

A claim needs three time concepts: when the source observed the fact, when the application retrieved
the record, and the interval for which the source says it applies. Missing dates stay unknown.
An explicit `asOf` input makes a dossier reproducible. A freshness policy must identify its owner
and basis before it can reject evidence as stale.

## Synthetic acceptance cases

These authored test scenarios use fictional properties and counts. The first implementation must
turn these scenarios into executable fixtures.

| Case                       | Supplied records                                                                                                                                                                                                         | Required result                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two frontages              | The fictional aliases `North entrance, Example House` and `South entrance, Example House` identify two entrances. A source explicitly links both entrances to Example House.                                             | Report one building and two entrances. Preserve both original aliases and the evidence for each link.                                                              |
| Shared parcel              | Example Parcel contains Example House and Example Annex. A source identifies 12 completed units in the house and 8 in the annex, with distinct unit membership at the same date.                                         | Report two buildings and 20 completed units, calculated as 12 + 8. Counting the parcel must not collapse the buildings.                                            |
| Conflicting counts         | A permit states 24 planned units for Example House. A later inspection states 20 completed units. A manager states 18 occupied units. Two sources disagree between 20 and 22 completed units at the same date and scope. | Display planned, completed and occupied claims separately. Preserve the 20-versus-22 conflict; an unresolved completed-unit total cannot become zero or their sum. |
| Separate customer events   | One household inquires, another orders, and a third has an active subscription. A manager signs a permission record whose stated scope covers only Example House's north entrance.                                       | Report each event with its own scope and date. Three events do not establish three active subscriptions. Permission remains scoped to the north entrance.          |
| Dated availability         | A provider advertises availability at Example House on one date. A later source withdraws the product. A nearby cabinet has no supplied connectivity or capacity record.                                                 | Answer the availability claim for the requested date. Preserve unknown connectivity and capacity. Provider presence does not establish uptake.                     |
| Missing and empty coverage | One layer has no survey for the query area. Another explicitly surveys the relevant feature category and extent and returns zero records. A third supplies a conflicting positive observation.                           | Preserve unknown, surveyed empty and conflicting evidence separately. Show each source's extent and date.                                                          |
| US denominator control     | Two filing rows describe different speed groups in the same block. The fixture supplies neither building membership nor a unit count.                                                                                    | Report one distinct block for the combined scope. Building, unit and subscriber totals remain unknown.                                                             |
| Construction and authority | A permit gives a construction window. A company owns Example House, another manages it, and signing authority is unknown in both records.                                                                                | Show the dated window and both roles. Request evidence of signing authority and build acceptance before asserting either.                                          |

## Existing extraction evidence

[#1375](https://github.com/sister-software/mailwoman/issues/1375) is closed. Its final comment records
real OSM extraction runs for District of Columbia and Vermont on 2026-08-11. The receipts report
18 District of Columbia rows and 103 Vermont rows. All 18 District of Columbia rows mapped into
the written coverage cells, and the independent Overpass query returned the same 18 features for
the administrative area. These historical receipts apply to those two extracts. Coverage at the
selected building requires its own measurement.

The same comment leaves TIGER centroid adequacy untested and records a coverage limitation:
the Vermont bounding-box coverage included territory outside the extract polygon. The source audit
in [#2286](https://github.com/sister-software/mailwoman/issues/2286) should reuse the extraction work
and inspect the current coverage implementation before treating an empty query as surveyed absence.

## Next implementation

Implement the supplied-record validator and dossier projection for the synthetic cases above.
Import shared evidence and address declarations from their owning packages. Keep calculations pure
and require explicit dates and count scopes. Source acquisition remains in #2286, investigation logic
in #2287, cost scenarios in #2288 and map presentation in #2289.

## Selected talk example: One Park Point

**Decided:** use `11 Ocean Parkway, Brooklyn, NY 11218`, marketed as One Park Point, to explain a
provider's pre-construction decision in 2022. The first product question is which developments meet
the operator's criteria for investigation before construction finishes. The dossier should show whom to approach, what
access and engineering evidence is missing, and which construction window the evidence supports.

**Observed on 2026-10-04:** the [property's website](https://oneparkpoint.com/) lists One Park Point at
11 Ocean Parkway, Brooklyn, NY 11218. The search-indexed extract of
[JEMB's project page](https://www.jembrealty.com/project/1-park-point-brooklyn-ny/) describes 375
residential units; direct retrieval returned HTTP 403. Preserve a directly retrieved source record
before using the count as a fixture assertion. This is a developer-reported residential count for the project;
occupied units, parcel unit totals and active subscriptions each require separate evidence.

These pages establish what their publishers currently state. A 2022 dossier must admit only records
available at its chosen cutoff. For every historical claim, retain both the event date and the date
the supporting record became available. A later financing event, completion record or provider
listing cannot justify a decision made before it existed. A side-by-side present-day dossier can
show what changed after that cutoff.

**Unknown for this implementation:** the complete frontage and entrance mapping, historical unit
counts, ownership and management roles at the cutoff, signing authority, available pathways, network
capacity, dated provider availability and subscriber demand. The source audit must resolve each
claim against an identified record before the talk presents it as a property fact.

The commercial scenario belongs to #2288. Its first output should be the cash required before the
first subscriber payment, with timing and cost assumptions supplied by an operator. Separate the
building connection from any shared route that could serve additional properties. Each additional
property needs its own identity and eligibility evidence before its units enter the scenario.
Show how delayed access, slower uptake or changed competitor pricing affects the result. These are
scenario inputs until observations establish them.

The talk can then follow one question through the issues: identify the property (#2285), establish
what the sources can support (#2286), choose the next investigation (#2287), calculate the supplied
cost scenarios (#2288), and display the resulting dossier (#2289). The Brooklyn illustration does
not establish UK source coverage; #2286 retains its London source-audit scope. Public-program
research remains separately scoped in #2290.
