# Data policy

This package compiles identifier data from published sources into lookup artifacts. This document states
where the data comes from, under what terms, what the open profile does and doesn't hold, and how a
source update moves through the repository.

## Profiles

A profile is a set of pinned sources with an identifier such as `open-2026-11`. An artifact's header states its profile, and every
predicate in this package answers for one profile. The built profile is `open-2026-11`.

| Profile             | Sources                                                | Where                                |
| ------------------- | ------------------------------------------------------ | ------------------------------------ |
| `open-2026-11`      | Wikidata ISO 3166-1 claims, OurAirports `airports.csv` | `data/normalized/`, `lib/artifacts/` |
| `fixture-synthetic` | Six invented countries and six invented airports       | `test/fixtures/`                     |

An official IATA location database or an ISO 3166 data product would be another profile with another
identifier, compiled by the same tools. A profile never substitutes for another under the same name.

## Sources and terms

`data/manifests/sources.lock.json` records each source's URL, SHA-256, byte count, the publication
marker the server stated, and the publisher's statement of terms with the page it was read from.

| Source                     | Terms the publisher states                                                                                                                                                        | Elected |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Wikidata (SPARQL)          | Structured data under CC0 1.0 (https://www.wikidata.org/wiki/Wikidata:Licensing)                                                                                                  | yes     |
| OurAirports                | "All data is released to the Public Domain, and comes with no guarantee of accuracy or fitness for use." (https://ourairports.com/data/)                                          | yes     |
| UN Statistics Division M49 | "personal, non-commercial use, without any right to resell or redistribute them or to compile or create derivative works therefrom" (https://www.un.org/en/about-us/terms-of-use) | no      |

The UN crosswalk is recorded under `$notElected` in the lock. The repository's rule
(`packages/corpus/AGENTS.md`, "License election") is that a grant enumerates its rights and an omission
is neither permission nor prohibition. Here the terms refuse redistribution and derivative works in their
own words, so the source stays unpinned and the compiler reads the two elected sources only.

## What the open profile holds

The coverage declaration is `data/manifests/coverage.json`, written by `tools/normalize.run.ts` from the
pinned bytes. At the pinned publication:

- `iso3166-1-alpha2`, `iso3166-1-alpha3`, `iso3166-1-numeric`: 249 officially assigned entries, plus 4
  entries whose state has ended (`AN`, `DD`, `PC`, `SU`) kept with status `formerly-used`. The status is
  read from Wikidata's dissolution date (P576). A former code is readable through `getCountryBy*` and
  refused by the strict predicates and brands.
- `iata-location`: 9,053 codes, every one on an OurAirports row of type `large_airport`,
  `medium_airport`, `small_airport`, `seaplane_base` or `heliport`. Metropolitan and intermodal codes are
  unsupported in this profile, so `PAR` is `not-found-in-snapshot` although IATA assigns it.
- `icao-location`: the `icao_code` column of those rows. `ident` and `gps_code` are not read as ICAO
  assignments.
- An airport's country is the `iso_country` column as the source spells it, with a status: `iso3166-1`
  when the code is a current alpha-2 entry, `source-extension` for a code such as `XK`, `unstated` when
  the column is empty. The `airport-located-in-country` relation holds only the first kind.

A miss means `not-found-in-snapshot`: the source holds no such code. It isn't a claim that the issuing
authority never assigned it.

OurAirports and Wikidata disagree on the country list in a way the coverage declaration records rather
than hides: OurAirports lists `XK`, `XP` and `ZZ`, which are not ISO codes, and lists no entry for `AX`,
`BV` or `SJ`, which are.

## How a source update moves through the repository

1. `node packages/registry/sdk/fetch.run.ts --repin` downloads the sources into
   `$MAILWOMAN_CACHE_ROOT/sources/registry/` and rewrites the lock. Without `--repin`, a changed
   publication fails the run.
2. `node packages/registry/tools/normalize.run.ts` rewrites `data/normalized/*.json` and
   `data/manifests/coverage.json`. The normalized files hold one record per line so the diff reads by
   record.
3. `node packages/registry/tools/generate.run.ts` compiles the artifacts with `crates/registry-build`,
   rewrites `lib/artifacts/*.ts` and `data/manifests/artifacts.json`, and recompiles the fixture profile.
4. `git diff --stat packages/registry/data` is the semantic diff: added, removed and changed records,
   and the coverage counts that moved. The collision count in `country-airport-collision`'s header
   moves with it.

Network access happens only in step 1. A build never fetches.

## What's not committed

The raw source files live under the data root and are not committed. The lock's digests identify them.
`PROVENANCE.md` conventions for the corpus do not apply here because no row of these sources trains a
model.
