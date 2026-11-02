# `@mailwoman/undersea`

This private workspace builds the IHO-IOC GEBCO Gazetteer of Undersea Feature Names into a sealed layer
and a browser asset. Earth draws the asset's names on the ocean and searches them, so a query such as
`Mariana Trench` finds the trench. Issue #2896 records the source decision.

## Source and terms

NOAA NCEI publishes the gazetteer as a public ArcGIS feature service owned by `ncei_noaa`:
`https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/Undersea_Features/FeatureServer`.
Layer 0 holds points, layer 1 lines and layer 2 polygons. Each record has `NAME`, `TYPE` (the generic term,
such as `Trench`) and `FEATURE_ID`. The service records no depth.

The manifest records `LicenseRef-USGov-Public-Domain`, under the repository's reading of United States
government factual data. GEBCO asks for the citation `IHO-IOC GEBCO Gazetteer of Undersea Feature Names,
www.gebco.net`, which the manifest records and the Earth footer shows. GEBCO's disclaimer excludes use for
navigation or for safety at sea.

## Build

```sh
yarn workspace @mailwoman/undersea build:layer
```

The run reads the three service layers into `$MAILWOMAN_DATA_ROOT/src/undersea/<date>/`, with a
`receipt.json` holding each file's record count and SHA-256. It refuses a pull whose count differs from the
count the service declares. `--source <dir>` rebuilds from a kept download.

It writes two files under `$MAILWOMAN_DATA_ROOT/db/undersea/`:

- `undersea-gebco.db` holds the `undersea_feature` table, one row per record and geometry kind with the
  publisher's geometry as GeoJSON, plus `layer_manifest` and `layer_coverage`. Coverage rows use the
  `source_present` basis at H3 resolution 3.
- `undersea-features.geojson` is the browser asset. A line keeps its longest part, so a label can follow a
  trench. A point or polygon becomes its label point, with its bounding box in the properties.

The 2026-11-02 pull held 2,632 points, 1,128 lines and 1,652 polygons, and the build kept all 5,412.
Earth reads the asset from `https://public.mailwoman.ai/undersea/gebco-2026-11-02/undersea-features.geojson`.
A new pull goes to a new dated path, and `PRODUCTION_CONFIG.underseaFeaturesURL` in
`packages/earth/lib/config.ts` moves with it.
