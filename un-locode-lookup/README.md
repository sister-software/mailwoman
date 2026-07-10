# @mailwoman/un-locode-lookup

Place → **UN/LOCODE** (the UNECE Code for Trade and Transport Locations — `US NYC`, `NL RTM`). Look up
by country + place name, or by nearest coordinate. `node:sqlite` over the UNECE code list. An
[`@mailwoman/annotations`](../annotations) `Annotator`.

## Build the DB

```bash
# from the UNECE code list (e.g. datasets/un-locode code-list.csv)
npx @mailwoman/un-locode-lookup build --csv code-list.csv --out un-locode.db
```

## Look up

```bash
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

Name matching is diacritic-folded and case-insensitive. ~80% of UN/LOCODE entries carry coordinates
(93k of 116k), so `nearest` is broadly useful; `byName` is exact. Data: UNECE UN/LOCODE (public domain
code list).
