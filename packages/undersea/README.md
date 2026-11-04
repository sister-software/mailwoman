# `@mailwoman/undersea`

This private workspace builds the IHO-IOC GEBCO Gazetteer of Undersea Feature Names into a sealed layer
and a browser asset. Earth draws the asset's names on the ocean and searches them, so a query such as
`Mariana Trench` finds the trench. Issue #2896 records the source decision.

## Source and terms

NOAA NCEI publishes the gazetteer as a public ArcGIS feature service owned by `ncei_noaa`:
`https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/Undersea_Features/FeatureServer`.
Layer 0 holds points, layer 1 lines and layer 2 polygons. Each record has `NAME`, `TYPE` (the generic term,
such as `Trench`) and `FEATURE_ID`. The service records no depth.

The manifest records `LicenseRef-GEBCO-Operator-Election`: the operator's own election of 2026-11-02, made
without a written grant. GEBCO and NOAA NCEI publish the gazetteer with a citation request and no stated
restriction, and GEBCO's disclaimer excludes only use for navigation or for safety at sea.
`docs/engineering/reference/layer-interface.mdx` records the basis. The citation `IHO-IOC GEBCO Gazetteer of
Undersea Feature Names, www.gebco.net` is in the manifest and the Earth footer. A request for written
confirmation has gone to GEBCO, and if its reply restricts reuse, the layer moves to GeoNames class `U`.

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

## Depths

The service records no depth. The build reads one from the terrarium elevation tiles the map draws, which
hold NOAA ETOPO1 bathymetry offshore at about 1.8 km per sample, through the tile worker at z8. Only a
depression gets a depth: a deep, hole, trench, trough, basin, plain, canyon, valley or caldera reports its
deepest sample. The grid reads Challenger Deep at −10,763 m against about −10,920 m surveyed, so a depth is
the grid's value rather than a sounding. A rise gets none, because the grid smooths a summit away: Vema
Seamount, about 11 m below the surface at its top, reads −1,206 m.

## Published asset

The 2026-11-02 pull held 2,632 points, 1,128 lines and 1,652 polygons, and the build kept all 5,412. It read
a depth for 1,175 of the 1,176 depressions. Earth reads the asset from
`https://public.mailwoman.post/undersea/gebco-2026-11-02/v2/undersea-features.geojson`. The path is served as
immutable, so a changed asset goes to a new path, and `PRODUCTION_CONFIG.underseaFeaturesURL` in
`packages/earth/lib/config.ts` moves with it.
