---
title: Displaying Results on a Map
id: display-on-a-map
role: guide
audience: product-reader
source-of-truth: registry/resolve.ts, registry/geojson.ts, registry/map-html.ts
prerequisites: "@mailwoman/registry, plus resolved entities to plot"
verified-with: mailwoman v6.1.0
---

Coordinates in a JSON array tell you the geocoder worked. They don't tell you whether the _answers_ are right — that a cluster of clinics really sits where you'd expect, that the three records you merged into one entity actually share a building. For that you need to see them on a map, and you'd rather not stand up a tile server and a frontend to glance at a few hundred points.

`@mailwoman/registry` renders a self-contained map for you. You hand it resolved entities; it hands back a single HTML file you open in a browser. By the end you'll have a `map.html` you can open locally or serve from anywhere. [Geocode-first record matching](../concepts/geocode-first-record-matching.mdx) covers how `resolveEntities` gets from raw records to the entities this recipe maps.

## From records to a map

The path is three calls. Resolve your source records into canonical entities, turn those into GeoJSON, and render the GeoJSON to HTML:

```ts
import { resolveEntities, toGeoJSON, toMapHTML } from "@mailwoman/registry"
import { writeFileSync } from "node:fs"

const { entities } = resolveEntities(records)
const html = toMapHTML(toGeoJSON(entities), { title: "Clinics — resolved" })

writeFileSync("map.html", html)
```

`toGeoJSON` is also the export your analysts want — the same FeatureCollection drops straight into QGIS — so you're not rendering to a dead end. The HTML is just the quick-look view over the same data.

## What you're looking at

The page renders on the house stack: MapLibre GL over a Protomaps vector basemap, the same one [the demo map](https://mailwoman.sister.software/demo) uses. Markers encode the resolution story: by default, colour shows how many source datasets agreed on an entity — a point that ≥2 datasets pinned stands out from a single-source one, which is the cross-dataset confirmation you're usually scanning for. If your reconciliation output tags each entity with a `bucket`, the map colours by that instead. You can force either with the `colorBy` option, and pick a basemap with `flavor`:

```ts
toMapHTML(fc, { title: "Funded sites", flavor: "dark", colorBy: "sources" })
```

The flavors are the Protomaps stock set — `light` (the default, data reads cleanly over it), `dark`, `white`, `grayscale`, `black`.

## The one gotcha: tiles need an origin

The basemap tiles come from R2, and they're CORS-restricted to `localhost` and the docs domains. Open `map.html` straight off your disk as a `file://` page and your data points render perfectly while the basemap underneath them stays blank — the tile fetches get refused. The page notices it's running from `file://` and shows a banner saying so, so you're not left guessing.

Serve the file over localhost and the basemap fills in:

```bash
npx serve .   # then open http://localhost:3000/map.html
```

Your points are accurate either way; it's only the map _under_ them that wants the origin.
