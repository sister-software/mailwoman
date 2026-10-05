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

## The Example House report

The report below is the verbatim output of `renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))`
over the fixture records. A layer reading with a `subject` attaches to that building and to no other. A
reading without a `subject` attaches to every building until
[#2289](https://github.com/sister-software/mailwoman/issues/2289) adds a spatial key. The fixture's readings
carry no `subject`, which is why the Annex shows the same three readings as the House.

```markdown
# Building dossier as of 2022-06-30

## Records

Admitted (3): permit-2021, inspection-2022, survey-2022
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
- cabinets over cell-1: surveyed, zero records. Absence is established for the surveyed extent
- poles over cell-1: the source looked and found no record; absence is unknown

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
- cabinets over cell-1: surveyed, zero records. Absence is established for the surveyed extent
- poles over cell-1: the source looked and found no record; absence is unknown

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
```
