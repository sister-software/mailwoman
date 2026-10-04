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
