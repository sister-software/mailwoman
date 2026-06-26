# @mailwoman/nuts-lookup

EU coordinate → **NUTS** statistical-region codes (levels 1–3 — the way OpenCage returns them).
Point-in-polygon over the [Eurostat GISCO](https://ec.europa.eu/eurostat/web/gisco) NUTS boundaries in a
`node:sqlite` table. An [`@mailwoman/annotations`](../annotations) `Annotator`.

## Build the DB

```bash
# from a Eurostat GISCO NUTS GeoJSON (e.g. NUTS_RG_03M_2021_4326.geojson)
npx @mailwoman/nuts-lookup build --geojson NUTS_RG_03M_2021_4326.geojson --out nuts.db
```

## Look up

```bash
npx @mailwoman/nuts-lookup --db nuts.db 52.52 13.405
# {"nuts":{"level1":"DE3","level2":"DE30","level3":"DE300"}}   (Berlin)
```

## Library

```ts
import { NutsLookup, makeNutsAnnotator } from "@mailwoman/nuts-lookup"

const lookup = new NutsLookup({ databasePath: "nuts.db" })
lookup.find(52.52, 13.405) // { level1: "DE3", level2: "DE30", level3: "DE300" }

const annotator = makeNutsAnnotator(lookup) // fills AnnotationSet.nuts (EU only; abstains elsewhere)
```

NUTS ids nest by prefix, so the lookup finds the deepest containing region and derives its parents.
Data: Eurostat GISCO NUTS (© EuroGeographics for the administrative boundaries).
