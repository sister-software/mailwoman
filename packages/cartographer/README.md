# Nexus Cartographer

This package contains a collection of modules for rendering maps and spatial data.

## Basemap

A map uses MapLibre GL with a Protomaps vector basemap, never Leaflet and never raster tiles. The
basemap style comes from `@protomaps/basemaps` `layers(sourceId, flavor, {lang})`, with a stock flavor
or the house dark theme `MailwomanBaseFlavor` in `lib/base/theme.ts`. Tiles are PMTiles served by
`packages/tile-worker` at `tiles.mailwoman.ai`.

The tile worker reflects the `Origin` header for the site domains, any `localhost:<port>` origin and
the vscode-webview origin, so a generated map page is served over localhost rather than opened as a
`file://` URL.

`@mailwoman/cartographer` is published, so published code may depend on it.
