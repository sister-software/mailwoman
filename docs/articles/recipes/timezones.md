---
title: Looking up a Timezone
id: timezone-lookup
role: guide
audience: product-reader
source-of-truth: timezone-lookup/index.ts, timezone-lookup/build.ts, timezone-lookup/cli.ts
prerequisites: "@mailwoman/timezone-lookup (server-side, node:sqlite); a timezone-boundary-builder release to build the DB"
verified-with: mailwoman v6.1.0
---

You have a coordinate and you want the IANA timezone it lands in — `America/New_York`, `Asia/Tokyo`. The [`@mailwoman/timezone-lookup`](https://www.npmjs.com/package/@mailwoman/timezone-lookup) package does the point-in-polygon for you, over [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) polygons in a `node:sqlite` database. The UTC offset comes from `Intl`, so there's no tz-database dependency to keep patched.

Two costs to name up front. It's **server-side** — the polygon test runs over `node:sqlite`, so this is a backend lookup, not a browser one. And you build the database once from the boundary release before the first lookup.

## Build the database

Download the `combined-with-oceans.json` release from timezone-boundary-builder, then build the read-only DB you'll ship alongside your service:

```bash
npx @mailwoman/timezone-lookup build --geojson combined-with-oceans.json --out timezone.db
```

That's a one-time step. The `.db` is an immutable artifact — build it in CI, ship it with your deploy.

## CLI usage

Hand it a latitude and longitude. A leading `--` is required before a negative longitude, or the CLI's flag parser reads `-74.0060` as an unknown option and errors:

```bash
npx @mailwoman/timezone-lookup --db timezone.db -- 40.7128 -74.0060
# {"timezone":"America/New_York","offsetSec":-14400}
```

(The offset is the current UTC offset for that timezone: `-14400` is EDT in July, `-18000` for EST outside daylight saving.)

## Programmatic usage

```ts
import { TimezoneLookup, makeTimezoneAnnotator } from "@mailwoman/timezone-lookup"

const lookup = new TimezoneLookup({ databasePath: "timezone.db" })

lookup.find(35.6762, 139.6503) // "Asia/Tokyo"
```

Already using the annotations layer? Wrap the lookup as an `Annotator` and it fills `AnnotationSet.timezone` on any resolved result, so a timezone rides along with every geocode:

```ts
const annotator = makeTimezoneAnnotator(lookup)
```

## Data and licensing

The boundaries come from timezone-boundary-builder, which is **ODbL**. Attribution and share-alike apply to the database you build and distribute — [Data licensing](../licensing/data-provenance.md) is where that line falls and what you owe. A browser/WASM build is a follow-up; today the lookup is server-side.
