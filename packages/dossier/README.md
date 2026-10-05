# `@mailwoman/dossier`

A building dossier is the reviewable projection of everything supplied about one property: its identity
(parcels, buildings, entrances, units, namespaced external identifiers, aliases), its sourced position and
the extents a source places it in, the sourced claims made about it on eight independent axes, its unit
counts by stage and scope, its commercial events, its dated provider availability, and the readings of
coverage layers over its extents — together with every question the records leave unresolved and the one
record that would resolve each.

The package checks supplied property records and refuses dangling references, duplicate identifiers and
malformed dates; the admitted records project into a dossier for an explicit `asOf` date. A record is
admitted by its availability date alone, so a decision dated 2022 cannot rest on a record published in 2023. The package acquires no source, computes no cost, and renders no map: it checks what it is given and
says what the given records support. `reportLines` turns a dossier into the line records of the report an
operator reads, and `renderReport` prints them as Markdown.

The eight synthetic scenarios of the inventory spec
(`docs/superpowers/specs/2026-10-04-building-dossier-contract-inventory.md`) each live in a `describe`
block beside the module that decides them under `lib/*.test.ts`; the shared fictional records — Example
House, Example Annex and Example Parcel — are `test/fixtures/example-house.ts`.

## Memberships, positions and unplaced readings

A membership record states that a building lies in an extent, and it cites the source that says so. It
writes the extent as a layer reading writes it, such as `census-block:<GEOID>`, an H3 cell or a postcode.
A layer reading attaches to buildings by three rules, applied in order:

1. A reading with a `subject` attaches to that building and to no other.
2. A reading without a `subject` attaches to each building that an admitted membership places in the
   reading's extent.
3. The dossier lists a reading that neither rule places in `unplaced`, and no building's section shows it.

The route explanation of a failed check cites only readings that attach to the check's building. A
position record holds a building's latitude and longitude with its evidence, and a dossier admits it by its
source's availability date like every other record. Two admitted positions that state different locations
leave the building's position unresolved, and the report lists both. A synthetic position is labeled
synthetic wherever it appears. The dossier computes no geometry. The map model in
`@mailwoman/opportunity-map` reads the memberships and positions.

## Claims

A claim states one value about one entity on one of the eight axes, with its status and the record that
supports it. The report lists each building's claims after its layer readings. Each line gives the
claim's identifier, axis, predicate, value, status, source record and evidence date. The evidence date is
the claim's own `observedAt`, else its source record's `observedAt`, else the word `undated`. A record's
availability and retrieval dates never date a claim. A derived or inferred claim also lists the claims it
derives from, and an inferred claim gives its explanation.

`validateRecords` reports a `derivedFrom` identifier that names no supplied claim as an `unknown_claim`
error. A dossier admits a derived or inferred claim only when it admits every claim that the claim derives
from, whatever the date of the claim's own record.

## Line records and citations

`reportLines` returns the report as line records. Each record holds the line's text, the part of the
report it belongs to, its kind, the building whose section holds it, and the source records behind it.
`renderReport` prints the text of each record in order, one line per record, so the printed report and the
records cannot disagree. A line's kind says what the line states:

- A `conclusion` states a value that admitted records supply. Its text cites each of those records in
  parentheses after the value it supports.
- An `absence` states in words that no admitted record supplies a value, as `Permissions: none on record`,
  a provider answer of `unknown` and `no occupied count` do.
- A `question` is an unresolved question, the candidate answers the records give for it, or an
  explanation's hypothesis.
- A `guidance` line states the record or the action that would resolve a question or test an explanation.
- A `derivation` line gives the claims that a derived or inferred claim derives from, or an inferred
  claim's explanation.
- A `source` line describes source records: a list in the records header or an entry of the sources part.
- A `heading` titles a part or a block, and a `blank` line separates two blocks.

Every conclusion cites at least one admitted record, with one exception. An external identifier cites the
record that states it, and an identifier without evidence prints the words `source unstated` in place of
a citation. `validateRecords` reports each such identifier as an `identifier_without_evidence` warning. A
building's section shows an identifier once the dossier admits the record that states it, as it shows an
alias. A provider line gives each availability record's dates and record, and a provider answer of
`unknown` is an absence.

The sources part ends the report. It lists each admitted source record with its identifier, publisher,
title, URL when it has one, and its observation, availability and retrieval dates. A missing date prints
as the word `undated`.

## Serviceability checks

An availability check identifies a building, a layer, and the extent at which that layer's source keys
its lookup. `explainCheck` answers the check from every admitted reading of the layer at that extent,
whichever building the reading was supplied for and whether or not it attaches to a building. When the
latest readings hold no record, the dossier lists the explanations the admitted records support:
identity, access, capacity, installation and route. Each explanation is a hypothesis with its supporting
and conflicting records, the records it lacks, and an investigation with the next action if it holds and
if it fails. A zero on a `source_present` basis leaves absence unknown, so it is missing evidence and
never support. Only a `surveyed` or `designated` zero establishes an absence.

The section ranks the explanations only when each has one documented probability that cites a record.
Otherwise it shows each explanation's scenarios. A later reading that holds records resolves the
exception, and the explanations stay hypotheses about the earlier date. Every statement in the section
carries one of five kinds: fact, deduction, estimate, hypothesis or decision. An operator disposition
records which explanation the operator investigated and what the investigation found, and
`reportOutcomes` measures blocker accuracy and time saved with their denominators.

The One Park Point fixture (`test/fixtures/one-park-point.ts`) demonstrates the section on public records
in `lib/explanations.test.ts`. As of 2023-06-30, a zero at the building's census block leaves
installation and route as competing explanations, and as of 2026-10-05 the 2025-12-31 reading resolves
the exception. The building is the `subject` of each of the fixture's readings, as `bdcLayerReadings` in
`@mailwoman/bdc` writes a reading of a building's block. PLUTO 26v2 places the building in census block
360470504012000 and census tract 36047050401 from 2026-08-24. The building's position is the point that
NYC Planning's Geosearch returned for 11 Ocean Parkway on 2026-10-05, latitude 40.65017 and longitude
-73.97264, so a dossier admits it from that date. The same Geosearch record states the building's BIN, so
the report shows the BIN from that date too.

## The Example House report

The report below is the verbatim output of `renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))`
over the fixture records. The fixture's readings carry no `subject`, so each attaches through a
membership. The survey places Example House in cell-1, and the permit places Example House and Example
Annex in district-1. The Annex therefore shows only the district reading. No record places a building in
cell-3, so the report lists the cable reading there as unplaced, and the route explanation for Example
House does not cite it. Every position is synthetic, and the permit and the survey state two different
positions for the Annex. Example House's inferred claim c2 derives from its observed claim c1. The
evidence of c2 states no observation date, so the survey's observation date, 2022-03-15, dates it. The
fixture states no source for either building's identifier, so each prints `source unstated`.

```text
# Building dossier as of 2022-06-30

## Records

Admitted (4): permit-2021, inspection-2022, survey-2022, operator-log-2022
Excluded, available after the cutoff (1): manager-2023 (available 2023-02-01)
Undated, no availability date (1): undated-listing

## Example House

Identifiers: example:bin 1001 (source unstated)
Entrances: 2 (survey-2022). Aliases: "North entrance, Example House" (resolved) (survey-2022), "South entrance, Example House" (resolved) (survey-2022)
Position: -30.00012, -20.00034 (survey-2022), synthetic
Extents: cell-1 (survey-2022), district-1 (permit-2021)

### Units

- planned: 24 on 2021-05-10 (permit-2021)
- completed: 20 on 2022-04-01 (inspection-2022)
- occupied: unresolved — no occupied count on 2022-06-30 for building:example-house

### Events

- landlord_permission on 2022-05-10 (Example Management Co. Scope entrance:example-house-north) (survey-2022)

### Access

Permissions: Example Management Co for entrance:example-house-north (survey-2022)
Roles with known signing authority: none
Roles with unknown signing authority: Example Holdings LLC (owner) (permit-2021)

### Construction

- permit issued: 2021-06-01 to no end stated (permit-2021)

### Providers

- Example Fiber 1 Gbps: available on 2022-06-30 (from 2022-03-01 to 2022-09-30 per survey-2022)

### Layer readings

- ducts over cell-1: no survey. Unknown (survey-2022)
- cabinets over cell-1 as of 2022-03-15: surveyed, zero records. Absence is established for the surveyed extent (survey-2022)
- poles over cell-1: the source looked and found no record; absence is unknown (survey-2022)
- cable over cell-1 as of 2022-03-15: the source looked and found no record; absence is unknown (survey-2022)
- cable over district-1 as of 2022-03-15: records present (survey-2022)

### Claims

- c1 — premises storeys: 13 (observed, permit-2021, 2021-05-10)
- c2 — network nearest_cabinet_connects: "unknown" (inferred, survey-2022, 2022-03-15)
  - derives from: c1
  - explanation: A cabinet within 40 m is an observation of proximity, and connection requires its own record.

### Unresolved

- How many occupied units does Example House have?
  - would resolve: a dated occupied unit count for Example House
- Does Example Holdings LLC (owner) hold signing authority for Example House?
  - would resolve: a dated record naming the signatory for Example House
- When does the construction window that opened 2021-06-01 (permit issued) close? The record states no end.
  - would resolve: a completion or occupancy record for Example House
- What does the ducts layer hold for cell-1?
  - candidates: no survey (survey-2022)
  - would resolve: a surveyed or designated reading of ducts over cell-1
- What does the poles layer hold for cell-1?
  - candidates: 0 (survey-2022)
  - would resolve: a surveyed or designated reading of poles over cell-1
- What does the cable layer hold for cell-1 as of 2022-03-15?
  - candidates: 0 (survey-2022)
  - would resolve: a surveyed or designated reading of cable over cell-1

### Serviceability checks

#### Check house-cable: cable keyed at cell-1

Answer as of 2022-06-30:

- fact (survey-2022): The cable reading over cell-1 as of 2022-03-15 holds 0 records on a source_present basis.
- deduction (survey-2022): A reading on a source_present basis that holds no record does not support exclusion, so the absence of cable service at cell-1 on 2022-03-15 is unknown.

Exception at the 2022-03-15 readings, open.

Explanations checked: identity, access, capacity, installation and route.
Checked without a supporting record: identity and capacity.

- explanation: access
  - hypothesis: A provider may have lacked permission to install service at Example House on 2022-03-15.
  - supporting:
    - fact (survey-2022): Landlord permission e4 from Example Management Co for entrance:example-house-north is dated 2022-05-10, after 2022-03-15.
  - conflicting: none on record
  - missing: a dated landlord permission or refusal for Example House from a party with signing authority
  - missing: a record naming the signatory for Example House
  - investigate: Ask the owner or manager of Example House whether a permission for the provider was in force on 2022-03-15, and who signs for Example House.
  - if it holds: Seek a dated permission for Example House from the party with signing authority.
  - if it fails: Investigate installation and route next.
- explanation: installation
  - hypothesis: Example House may not have been ready to receive service on 2022-03-15.
  - supporting:
    - fact (permit-2021): The construction window "permit issued" opened 2021-06-01 and states no end.
  - conflicting:
    - fact (survey-2022): Example Fiber 1 Gbps is recorded as available at Example House on 2022-03-15.
  - missing: a completion or occupancy record for Example House dated on or before 2022-03-15
  - investigate: Retrieve Example House's completion or occupancy record and compare its date with 2022-03-15.
  - if it holds: Repeat the check on the first cable reading dated after Example House's completion.
  - if it fails: Investigate access and route next.
- explanation: route
  - hypothesis: The cable network may not have reached cell-1 on 2022-03-15.
  - supporting:
    - fact (survey-2022): The cable reading over district-1 as of 2022-03-15 holds 4 records.
  - conflicting: none on record
  - missing: a surveyed or designated reading of cable over cell-1, because a zero on a source_present basis establishes no absence
  - missing: the provider's plant record for cell-1
  - investigate: Obtain the provider's plant record for cell-1, or a surveyed reading of cable over it, dated on or before 2022-03-15.
  - if it holds: Request the route and cost of extending the cable network to cell-1.
  - if it fails: Investigate access and installation next.

Ranking: none. The access, installation and route explanations have no documented probability, so each explanation states the next action if it holds and if it fails.

Decisions and outcomes:

- decision (operator-log-2022): On 2022-06-01 the operator decided to investigate access: "Ask Example Management Co whether the provider holds permission for the south entrance".
- fact (operator-log-2022): On 2022-06-20 the operator recorded that the access explanation held.

## Example Annex

Identifiers: example:bin 1002 (source unstated)
Entrances: 0. Aliases: none
Position: unresolved — 2 positions state 2 different locations (-30.00021, -20.00032 per permit-2021, synthetic. -30.00025, -20.00041 per survey-2022, synthetic)
Extents: district-1 (permit-2021)

### Units

- planned: unresolved — no planned count on 2022-06-30 for building:example-annex
- completed: unresolved — no completed count on 2022-06-30 for building:example-annex
- occupied: unresolved — no occupied count on 2022-06-30 for building:example-annex

### Events


### Access

Permissions: none on record
Roles with known signing authority: none
Roles with unknown signing authority: none

### Construction


### Providers


### Layer readings

- cable over district-1 as of 2022-03-15: records present (survey-2022)

### Claims


### Unresolved

- Where is Example Annex?
  - candidates: -30.00021, -20.00032 (permit-2021). -30.00025, -20.00041 (survey-2022)
  - would resolve: a record that settles which of the 2 positions locates Example Annex
- How many planned units does Example Annex have?
  - would resolve: a dated planned unit count for Example Annex
- How many completed units does Example Annex have?
  - would resolve: a dated completed unit count for Example Annex
- How many occupied units does Example Annex have?
  - would resolve: a dated occupied unit count for Example Annex

## Unplaced layer readings

Neither a subject nor an admitted membership places these readings at a building, so no building's section shows them.

- cable over cell-3 as of 2022-03-15: records present (survey-2022)
  - would resolve: a record that places a building in cell-3

## Operator outcomes

- estimate (operator-log-2022): The investigated explanation held in 1 of 1 dispositions with a recorded outcome.
- estimate (operator-log-2022): Against the operator's baselines, the investigations saved 60 minutes over 1 outcome that records both times.

## Sources

- permit-2021: Example City Buildings Department, "New building permit" (observed 2021-05-10, available 2021-05-12, retrieved 2026-10-04)
- inspection-2022: Example City Buildings Department, "Inspection record" (observed 2022-04-01, available 2022-04-03, retrieved 2026-10-04)
- survey-2022: Example Surveyor, "Entrance survey" (observed 2022-03-15, available 2022-03-20, retrieved 2026-10-04)
- operator-log-2022: Example Operator, "Investigation log" (observed 2022-06-20, available 2022-06-25, retrieved 2026-10-04)
```
