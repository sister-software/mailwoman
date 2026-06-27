# @mailwoman/timezone-lookup

Coordinate → IANA timezone, server-side. Point-in-polygon over
[timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) polygons in a
`node:sqlite` DB; the UTC offset comes from `Intl` (no tz-database dependency). An
[`@mailwoman/annotations`](../annotations) `Annotator`.

## Build the DB

```bash
# from the downloaded combined-with-oceans.json (tz-boundary-builder release)
npx @mailwoman/timezone-lookup build --geojson combined-with-oceans.json --out timezone.db
```

## Look up

```bash
npx @mailwoman/timezone-lookup --db timezone.db 40.7128 -74.0060
# {"timezone":"America/New_York","offsetSec":-18000}
```

## Library

```ts
import { TimezoneLookup, makeTimezoneAnnotator } from "@mailwoman/timezone-lookup"

const lookup = new TimezoneLookup({ databasePath: "timezone.db" })
lookup.find(35.6762, 139.6503) // "Asia/Tokyo"

const annotator = makeTimezoneAnnotator(lookup) // fills AnnotationSet.timezone
```

Server-side only — the polygon PIP runs over `node:sqlite`. A browser/WASM build is a follow-up.

Data: timezone-boundary-builder (ODbL). Attribution + share-alike apply to the built DB.
