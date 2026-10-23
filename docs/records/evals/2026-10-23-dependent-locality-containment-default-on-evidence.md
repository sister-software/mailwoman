# Dependent-locality containment — default-on evidence (#2804)

**Date:** 2026-10-23 · **Decision:** default-ON, approved by the merge of the PR that closes #2804 · **Flag:** `dependentLocalityContainment`

A parsed `dependent_locality` node now resolves inside its resolved parent. Its lookup passes the parent as a
containment qualifier (`parentQualifierID`) in place of the `parentID` region scope, the candidate table's
containment re-rank reads the parent by id through the ancestors sidecar and injects the contained sub-locality rows
the locality band excludes, and a pick the parent contains is stamped `contained_by_parent` so the geocode result's
admin ladder lets it answer the coordinate ahead of the locality. `--no-dependent-locality-containment` (geocode),
`--dependent-locality-containment off` (eval gauntlet) and `dependent_locality_containment: "off"` (dev MCP) opt out.

## Why the band and the ladder both had to move

The codex maps `dependent_locality` to the `locality` placetype, so a dependent locality's lookup queried the band
`locality, borough, localadmin`. Who's On First types the districts the tag names `neighbourhood` or `macrohood`.
`Didsbury, Manchester` parsed as `dependent_locality` plus `locality`, the lookup for `Didsbury` returned no row
(`UNREACHABLE, not absent — the key lives in neighbourhood×2`), and the row answered Manchester's point 6.09 km from
the district. `Camden, London` resolved `Camden` to the GB `borough` 1158857277 inside the band, and the admin ladder
orders `locality` before `dependent_locality`, so London's point still answered 6.41 km away. The lookup scope was
also wrong in kind: `parentID` is applied as `region_id = ?`, which a locality parent never satisfies, so every
dependent-locality lookup fell back to the country-wide list.

The rule is planetary rather than a GB quirk. Against `/mnt/mw/db/wof/candidate.db`, the v0.8.2 train split's
`dependent_locality` surfaces (17,816 probed across 94 countries, the top 400 by rows and 400 at random per country,
905,194 train rows) read 6,729 inside the locality band (46.3% of rows), 5,094 only under a sub-locality placetype
(13.4%), 121 only elsewhere (6.2%) and 5,872 under no placetype in their country (34.2%). The sub-locality-only
surfaces sit in 12 countries and outnumber the in-band ones in 9 (JP 765 to 18, ES 536 to 221, DE 514 to 278, NL 506
to 279, KR 505 to 195, TW 504 to 221, GB 472 to 320, FR 406 to 379, IT 392 to 355). The `locality` control over the
same corpus (37,413 surfaces, 181 countries) reads 21 sub-locality-only surfaces against 32,881 in band, so the widening
is specific to the tag. The per-country table is on #2804.

## Evidence (on against off, one declared variable, the house graders)

| leg                           | result                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| board (1,277, board-routed)   | 37 differed · **19 improved / 0 regressed / 1,258 neutral** · every improved row lands on its truth point (0.00 km, from 2.07 to 8.68 km) · z = 0.81 over the whole board, so the 1.5pp gap is inside noise there |
| panel v2.1 (420)              | **0 of 420 differed**, consistent with any true rate below 0.7%. The panel holds no parsed dependent locality the change reaches                                                                                  |
| regression layer, pin on/off  | counted 595/643 on both arms · tracked failures 360 → 341 · `unreachable by data` 14 → 6 · 19 tracked rows now pass and are promotable · 0 counted rows regressed                                                 |
| metamorphic layer, pin on/off | the layer passes on both arms · INV 63/63 held and BAND 21/21 held on each, 0 known-xfail, identical                                                                                                              |

The 19 improved rows are the district-and-city and possessive families: `Altona, Hamburg`, `Kreuzberg, Berlin` (two
casings), `Schwabing, München`, `Triana, Sevilla`, `Camden, London` (two casings), `Clifton, Bristol`,
`Didsbury, Manchester`, `Hackney, London`, `Islington, London`, `Leith, Edinburgh`, `Earl's Court, London`,
`King's Cross, London` (two casings), `Queen's Park, London`, `Capitol Hill, Seattle`, `Hollywood, Los Angeles` and
`Wicker Park, Chicago`. Each is `improvement_target` and each now answers the district's own point.

The 18 neutral rows split in two. Nine resolve at the address-point or postcode tier and keep their coordinate
(`Neusser Str. 12, Nippes, 50733 Köln`, `Shop Eat Repeat, 173 West St, Kinning Park, Glasgow G5 8BN` among them):
only the dependent locality's identity in the hierarchy changed. Nine resolve at the admin tier with no coordinate
assertion, and their coordinate moved from the city's point to the district's by 0.65 to 11.17 km
(`Calle Mayor 12, Aravaca, 28023 Madrid` 9.22 km, `Via Roma 12, Trastevere, 00153 Roma` 11.17 km,
`123 Main St, Park Slope, Brooklyn, NY 11215` 3.03 km). One venue-led row moved closer and still misses:
`La Font del Cuento, Carrer de Garriga i Roca, 1, Horta-Guinardó, 08041 Barcelona, Spain` reads 0.30 km off at a
250 m tolerance, from 2.32 km.

## What the change does not reach

Six rows stay on the regression layer's `unreachable by data` list. The three ES venue-led rows (`es-op3-*`) assert
250 m on a venue the POI tier does not hold, and the district's point is not the venue's.
`La Croix-Rousse, Lyon` runs on the base weights under board routing (FR has no overlay) and the parse drops the
district, so no `dependent_locality` node reaches the resolver. `Chill Since \`93 - Covent Garden`parses its district
with no locality beside it, so there is no parent to contain it.`Little Britain Lake, Uxbridge`tags`Uxbridge`a`locality`, and the `locality` band is unchanged by design.

## Bounds

- The change is inert without the ancestors sidecar, and inert on a row whose parent did not resolve: both keep
  today's `parentID` scope and country-wide ranking.
- A dependent locality whose parent is a region rather than a locality is also contained by that region through the
  same sidecar. The board holds no such row with a coordinate assertion, so that path is unmeasured here.
- The `locality` band is unchanged. A bare district typed `neighbourhood` still resolves through the bare-toponym race
  and nowhere else.
- The parse decides whether the change can act: the three FR district rows on the board fail before the resolver, at
  the parse, and this change does not touch them.
