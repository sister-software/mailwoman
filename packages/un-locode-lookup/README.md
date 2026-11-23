# @mailwoman/un-locode-lookup

Place → **UN/LOCODE** (the UNECE Code for Trade and Transport Locations — `US NYC`, `NL RTM`). Look up
by country + place name, or by nearest coordinate. `node:sqlite` over the UNECE code list. An
[`@mailwoman/annotations`](../annotations) `Annotator`.

## Build the DB

```sh
# from the UNECE code list (e.g. datasets/un-locode code-list.csv)
npx @mailwoman/un-locode-lookup build --csv code-list.csv --out un-locode.db
```

## Look up

```sh
npx @mailwoman/un-locode-lookup --db un-locode.db --country NL --name "Rotterdam"
# {"unLocode":"NL RTM"}

npx @mailwoman/un-locode-lookup --db un-locode.db -- 40.7128 -74.0060
# {"unLocode":"US NYC"}
```

## Library

```ts
import { UnLocodeLookup, makeUnLocodeAnnotator } from "@mailwoman/un-locode-lookup"

const lookup = new UnLocodeLookup({ databasePath: "un-locode.db" })
lookup.byName("US", "New York") // "US NYC"
lookup.nearest(51.92, 4.48) // "NL RTM"

const annotator = makeUnLocodeAnnotator(lookup) // fills AnnotationSet.unLocode
```

Name matching is diacritic-folded and case-insensitive. ~80% of UN/LOCODE entries have coordinates
(93k of 116k), so `nearest` is broadly useful; `byName` is exact.

## Data terms

The code list is UNECE's UN/LOCODE, and this package ships no copy of it. The UN/LOCODE site's terms
grant use "for the User’s personal, non-commercial use, without any right to resell or redistribute
them or to compile or create derivative works therefrom". The site's footer also states "All
UN/CEFACT standards are free to use under CC By 4.0 license". The repository elects the stricter
reading, under which every commercial purpose is refused. The decision is
`unchecked-access-free-ch-united-nations-economic-commission-for-europe` in
`packages/corpus/data/license-decisions.json`, and it records the reasoning.
