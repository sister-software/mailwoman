# `@mailwoman/dossier`

A building dossier is the reviewable projection of everything supplied about one property: its identity
(parcels, buildings, entrances, units, namespaced external identifiers, aliases), the sourced claims made
about it on eight independent axes, its unit counts by stage and scope, its commercial events, its dated
provider availability, and the readings of coverage layers over its extent — together with every question
the records leave unresolved and the one record that would resolve each.

The package checks supplied property records and refuses dangling references, duplicate identifiers and
malformed dates; the admitted records project into a dossier for an explicit `asOf` date. A record is
admitted by its availability date alone, so a decision dated 2022 cannot rest on a record published in 2023. The package acquires no source, computes no cost, and renders no map: it checks what it is given and
says what the given records support. `renderReport` turns a dossier into the Markdown report an operator
reads.

The eight synthetic scenarios of the inventory spec
(`docs/superpowers/specs/2026-10-04-building-dossier-contract-inventory.md`) each live in a `describe`
block beside the module that decides them under `lib/*.test.ts`; the shared fictional records — Example
House, Example Annex and Example Parcel — are `test/fixtures/example-house.ts`.

## Serviceability checks

An availability check identifies a building, a layer, and the extent at which that layer's source keys
its lookup. `explainCheck` answers the check from every admitted reading of the layer at that extent,
whichever building the reading was supplied for. When the latest readings hold no record, the dossier
lists the explanations the admitted records support: identity, access, capacity, installation and route.
Each explanation is a hypothesis with its supporting and conflicting records, the records it lacks, and an
investigation with the next action if it holds and if it fails. A zero on a `source_present` basis leaves
absence unknown, so it is missing evidence and never support. Only a `surveyed` or `designated` zero
establishes an absence.

The section ranks the explanations only when each has one documented probability that cites a record.
Otherwise it shows each explanation's scenarios. A later reading that holds records resolves the
exception, and the explanations stay hypotheses about the earlier date. Every statement in the section
carries one of five kinds: fact, deduction, estimate, hypothesis or decision. An operator disposition
records which explanation the operator investigated and what the investigation found, and
`reportOutcomes` measures blocker accuracy and time saved with their denominators.

The One Park Point fixture (`test/fixtures/one-park-point.ts`) demonstrates the section on public records
in `lib/explanations.test.ts`. As of 2023-06-30, a zero at the building's census block leaves
installation and route as competing explanations, and as of 2026-10-05 the 2025-12-31 reading resolves
the exception.

## The Example House report

The report below is the verbatim output of `renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))`
over the fixture records. A layer reading with a `subject` attaches to that building and to no other. A
reading without a `subject` attaches to every building until
[#2289](https://github.com/sister-software/mailwoman/issues/2289) adds a spatial key. The fixture's readings
carry no `subject`, which is why the Annex shows the same five readings as the House.

```text
# Building dossier as of 2022-06-30

## Records

Admitted (4): permit-2021, inspection-2022, survey-2022, operator-log-2022
Excluded, available after the cutoff (1): manager-2023 (available 2023-02-01)
Undated, no availability date (1): undated-listing

## Example House

Identifiers: example:bin 1001
Entrances: 2. Aliases: "North entrance, Example House" (resolved), "South entrance, Example House" (resolved)

### Units

- planned: 24 on 2021-05-10 (permit-2021)
- completed: 20 on 2022-04-01 (inspection-2022)
- occupied: unresolved — no occupied count on 2022-06-30 for building:example-house

### Events

- landlord_permission on 2022-05-10 (Example Management Co. Scope entrance:example-house-north)

### Access

Permissions: Example Management Co for entrance:example-house-north
Roles with known signing authority: none
Roles with unknown signing authority: Example Holdings LLC (owner)

### Construction

- permit issued: 2021-06-01 to no end stated (permit-2021)

### Providers

- Example Fiber 1 Gbps: available on 2022-06-30

### Layer readings

- ducts over cell-1: no survey. Unknown
- cabinets over cell-1 as of 2022-03-15: surveyed, zero records. Absence is established for the surveyed extent
- poles over cell-1: the source looked and found no record; absence is unknown
- cable over cell-1 as of 2022-03-15: the source looked and found no record; absence is unknown
- cable over district-1 as of 2022-03-15: records present

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

Identifiers: example:bin 1002
Entrances: 0. Aliases: none

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

- ducts over cell-1: no survey. Unknown
- cabinets over cell-1 as of 2022-03-15: surveyed, zero records. Absence is established for the surveyed extent
- poles over cell-1: the source looked and found no record; absence is unknown
- cable over cell-1 as of 2022-03-15: the source looked and found no record; absence is unknown
- cable over district-1 as of 2022-03-15: records present

### Unresolved

- How many planned units does Example Annex have?
  - would resolve: a dated planned unit count for Example Annex
- How many completed units does Example Annex have?
  - would resolve: a dated completed unit count for Example Annex
- How many occupied units does Example Annex have?
  - would resolve: a dated occupied unit count for Example Annex
- What does the ducts layer hold for cell-1?
  - candidates: no survey (survey-2022)
  - would resolve: a surveyed or designated reading of ducts over cell-1
- What does the poles layer hold for cell-1?
  - candidates: 0 (survey-2022)
  - would resolve: a surveyed or designated reading of poles over cell-1
- What does the cable layer hold for cell-1 as of 2022-03-15?
  - candidates: 0 (survey-2022)
  - would resolve: a surveyed or designated reading of cable over cell-1

## Operator outcomes

- estimate (operator-log-2022): The investigated explanation held in 1 of 1 dispositions with a recorded outcome.
- estimate (operator-log-2022): Against the operator's baselines, the investigations saved 60 minutes over 1 outcome that records both times.
```
