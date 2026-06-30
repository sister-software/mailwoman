---
title: UN/LOCODE Lookup
id: un-locode-lookup
---

A **UN/LOCODE** is the UNECE's code for a trade-and-transport location — `US NYC` for New York, `NL RTM` for Rotterdam. If you're moving freight, filing customs, or matching a shipping record to a place, you need these codes, and you usually have either a place name or a coordinate to start from. The [`@mailwoman/un-locode-lookup`](https://www.npmjs.com/package/@mailwoman/un-locode-lookup) package goes both ways, over the UNECE code list in a `node:sqlite` database.

Like the timezone lookup, it's **server-side** and you build the database once before the first query.

## Build the database

Grab the UNECE code list (`code-list.csv`) and build the read-only DB:

```bash
npx @mailwoman/un-locode-lookup build --csv code-list.csv --out un-locode.db
```

## CLI usage

By country and place name, or by nearest coordinate:

```bash
npx @mailwoman/un-locode-lookup --db un-locode.db --country NL --name "Rotterdam"
# {"unLocode":"NL RTM"}

npx @mailwoman/un-locode-lookup --db un-locode.db --near 40.7128 -74.0060
# {"unLocode":"US NYC"}
```

## Programmatic usage

```ts
import { UnLocodeLookup, makeUnLocodeAnnotator } from "@mailwoman/un-locode-lookup"

const lookup = new UnLocodeLookup({ databasePath: "un-locode.db" })

lookup.byName("US", "New York") // "US NYC"
lookup.nearest(51.92, 4.48) // "NL RTM"
```

`byName` is exact, but the match is diacritic-folded and case-insensitive, so "São Paulo" and "sao paulo" both land. `nearest` covers the roughly 80% of entries that carry coordinates (93k of 116k), which is most of what you'll reach for. Wrap it as an `Annotator` to fill `AnnotationSet.unLocode` on a resolved result:

```ts
const annotator = makeUnLocodeAnnotator(lookup)
```

## Data

The UNECE UN/LOCODE code list is public domain, so this one carries no share-alike obligation — see [Data licensing](../licensing/data-provenance.md) for how the sources differ.
