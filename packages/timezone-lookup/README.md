# @mailwoman/timezone-lookup

This package maps coordinates to IANA timezones on the server. It runs point-in-polygon lookups over
[timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) polygons in a
`node:sqlite` database. The UTC offset comes from `Intl`, with no tz-database dependency. The package
also provides an [`@mailwoman/annotations`](../annotations) `Annotator`.

## Build the DB

```sh
# from the downloaded combined-with-oceans.json (tz-boundary-builder release)
npx @mailwoman/timezone-lookup build --geojson combined-with-oceans.json --out timezone.db
```

## Look up

```sh
npx @mailwoman/timezone-lookup --db timezone.db -- 40.7128 -74.0060
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
