# Cartographer

This package contains a collection of modules for rendering maps and spatial data.

## Basemap

A map uses MapLibre GL with a Protomaps vector basemap, never Leaflet and never raster tiles. The
basemap style comes from `@protomaps/basemaps` `layers(sourceId, flavor, {lang})`, with a stock flavor
or the house dark theme `MailwomanBaseFlavor` in `lib/base/theme.ts`. Tiles are PMTiles served by
`packages/tile-worker` at `tiles.mailwoman.post`.

`createBasemapStyle` in `lib/base/standalone.ts` builds a self-contained style from a tileset's TileJSON: one
vector source and the `@protomaps/basemaps` layers, with none of Earth's terrain, bathymetry or buildings sources. The
tile worker serves it at `/styles/<style>.json`, for clients that read only vector tiles, such as QGIS.

The tile worker reflects the `Origin` header for the site domains, any `localhost:<port>` origin and
the vscode-webview origin, so a generated map page is served over localhost rather than opened as a
`file://` URL.

`@mailwoman/cartographer` is published, so published code may depend on it.
