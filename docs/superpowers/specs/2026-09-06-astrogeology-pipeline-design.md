# Astrogeology: the Moon and Mars data pipeline

**Status:** design approved 2026-09-06. Decisions the operator took: the package is `packages/astrogeology`,
named for its source the way `tiger`, `ban` and `osm` are; it is `private: true` for v1; fetchers live under
`lib/sdk/`.
**Builds on:** the `RegionDatabaseProvider` acquisition convention (`packages/tiger/lib/sdk`,
`packages/ban/lib/sdk`), `mailwoman tiles publish`, and the tile worker's PMTiles routes.
**Precedes:** `2026-09-06-planetary-app-design.md`, which renders what this pipeline builds. The two are
independent of the Earth app and can proceed in parallel with it.
**Supersedes:** the data half of the uploaded "Planetary Maps for Mailwoman" proposal.

## The problem

Moon and Mars have authoritative, public-domain nomenclature and topography, and nothing in the
repository can read, normalize or publish them. Every existing acquisition package assumes Earth: a
country, a WGS84 coordinate, an elevation above sea level, a radius of 6,371 km typed once in
`@mailwoman/spatial` and refused everywhere else by the `prefer-home` rule. A planetary pipeline is
therefore also a conformance test for the geographic primitives, and it exposes each Earth assumption
at the point where a body parameter is missing.

## Decisions taken

**One package for the three USGS Astrogeology products.** The nomenclature gazetteer, the LOLA lunar
DEM mosaic, and the MOLA MEGDR Martian DEM mosaic are all published by USGS Astrogeology, so the source
name covers all three the way `tiger` covers every TIGER/Line product.

**Private for v1.** Nothing published consumes it until `mw geocode --body moon` exists, which is after
v1. It joins `SANCTIONED_RELEASE_ABSENCES` with "private planetary data pipeline — no published consumer
yet". The first publish, when it comes, goes through `bless-package`.

**Its own bin.** The published `mailwoman` CLI cannot depend on a private workspace, so the package ships
an `astrogeology` bin built on `mailwoman/cli-kit` (`useCommandTask`, `CheckList`, the command component
types), the same helpers `mailwoman` commands use.

**Hillshade before DEM.** v1 ships the vector archive and a pre-rendered hillshade raster per body. The
DEM archive for MapLibre terrain is a later product, in `terrarium` encoding because that is the encoding
`packages/cartographer/lib/base/terrain.ts` already reads for Earth.

**Normalize once, at build.** Rendering coordinates are east-positive longitude in −180..180 and
planetocentric latitude. Source conventions are recorded in the manifest, never guessed in the browser.

**Checksum drift stops the build.** A source whose SHA-256 differs from the pinned value fails the build
with both hashes printed. Nothing rebuilds a changed world under the same version.

## Design

### Package

```text
packages/astrogeology/
  package.json          @mailwoman/astrogeology, private, bin: astrogeology
  tsconfig.json, tsconfig.test.json
  lib/
    bodies.ts           PlanetaryBody records: id, name, iauTargetName, meanRadiusKm, coordinate convention, source
    schema/
      nomenclature.ts   PlanetaryNomenclatureFeature (zod) and its tile-property projection
      manifest.ts       PlanetaryBuildManifest (zod)
    sdk/
      sources.ts        pinned source table: URL, expected sha256, version label, product ID, license
      nomenclature.ts   fetch + unzip the USGS GIS download per body
      dem.ts            fetch the LOLA / MOLA mosaic; raw fetch streamed to disk (a file transfer, not an API request)
    build/
      normalize.ts      source rows to PlanetaryNomenclatureFeature; coordinate normalization; stable IDs
      nomenclature.ts   features to GeoJSON, tippecanoe to <body>.pmtiles, metadata write
      hillshade.ts      gdaldem hillshade over the reprojected DEM, then raster tiles to <body>-hillshade.pmtiles
      search-index.ts   the @mailwoman/ancestrie artifact over feature names and aliases
      manifest.ts       emit the build manifest with source and output checksums
    commands/           the bin's commands: fetch, build, verify, publish (publish delegates to mailwoman tiles publish)
  test/
    fixtures/           a few features per body, one within 1° of ±180°, one within 1° of a pole, a 64×64 synthetic DEM
```

### Data root layout

```text
$MAILWOMAN_DATA_ROOT/astrogeology/<body>/source/   cached downloads, keyed by sha256
$MAILWOMAN_DATA_ROOT/astrogeology/<body>/build/    GeoJSON, reprojected rasters, PMTiles, manifest.json
```

Paths compose through `dataRootPath("astrogeology", body, …)`. A build from a warm `source/` needs no
network.

### Bodies

```ts
type PlanetaryBodyID = "earth" | "moon" | "mars"
```

`earth` is in the union so a future shared primitive can take a body without a second type; nothing in
this package produces Earth data. Each record carries the IAU target name, the mean radius with its
source, and the coordinate convention the rendering path uses.

### Coordinates

The USGS GIS downloads use east longitude and planetocentric latitude, with Mars-specific caveats
documented on the download page. `normalize.ts` converts 0..360 to −180..180, records
`{ longitudeDirection, longitudeRange, latitudeType, referenceBody, controlNetwork }` from the source
into the manifest, and rejects a latitude outside ±90 or a longitude that cannot be normalized. A polygon
that crosses ±180° is split at the antimeridian before tiling, and the fixture with the ±180° feature
asserts its bounding box stays narrower than 180° after conversion.

### Nomenclature features

```ts
interface PlanetaryNomenclatureFeature {
	id: string // the USGS feature ID when present; else sha256 over (body, name, featureType, centerLon, centerLat)
	body: PlanetaryBodyID
	name: string
	cleanName?: string
	featureType: string
	featureTypeCode?: string
	diameterKm?: number
	centerLon: number
	centerLat: number
	approvalStatus?: string
	approvalDate?: string
	origin?: string
	source: "usgs-iau"
}
```

One tile layer, `nomenclature`, with geometry-dependent rendering; separate layers for lines and
polygons only if the source warrants them once inspected. Tile properties are a projection of the
record, and `diameterKm` is carried so the style can declutter by scale.

### Terrain

Source products are pinned in `sources.ts` at C1 of the implementation plan: the LOLA global gridded DEM
(a USGS-distributed ~118 m/pixel product or its PDS equivalent) and the MOLA MEGDR global mosaic. The
pipeline reprojects to the rendering grid with GDAL, records the exact transformation, and never
discards the source geodesy metadata. Vertical values are `elevation_m` with `vertical_datum` and
`reference_surface` named per body; no field is called sea level.

Hillshade is `gdaldem hillshade` on the reprojected DEM, tiled to a raster PMTiles with `png` tiles. The
tile worker already maps `png` and `webp` to their content types from the PMTiles header, so the archive
serves through the existing `/:tileSetName/{z}/{x}/{y}.png` route with no worker change.

### PMTiles metadata

Every archive carries, beside ordinary TileJSON, a validated `mailwoman:*` block: `kind`
(`planetary-basemap` | `planetary-hillshade` | `planetary-dem`), `body`, `schema` (`planetary-v1`),
`coordinate_longitude`, `coordinate_latitude`, `source`, `build_version`, and for a DEM
`vertical_datum`, `elevation_unit`, `source_product`. `verify` refuses an archive whose block fails the
zod schema or whose `body` disagrees with the manifest.

### Build manifest

```json
{
  "schemaVersion": 1,
  "body": "moon",
  "builtAt": "…",
  "sources": [{ "id": "usgs-nomenclature-moon", "url": "…", "sha256": "…", "version": "…", "coordinates": { … } }],
  "outputs": [{ "tileset": "moon", "path": "moon.pmtiles", "sha256": "…", "bytes": 0 }]
}
```

The manifest is the reproducibility record and the input to the app's attribution panel.

### Publishing

`astrogeology publish --body moon` runs `mailwoman tiles publish --tileset moon --file …` and
`--tileset moon-hillshade`, then fetches `https://tiles.mailwoman.ai/moon.json` and one low-zoom and
one high-zoom tile to confirm the route answers. The bucket and prefix are the tile worker's
(`nexus-assets`, `tiles/`).

### `@mailwoman/spatial`

`haversine` keys its radius by unit only. Before this pipeline computes a distance, `spatial` gains a
body-radius parameter: `haversine(a, b, { unit, radiusKm })` with the Earth radius as the default, and
the `RADII` table becomes the Earth entry of a per-body table exported for the three bodies. The
`prefer-home` rule keeps refusing a radius typed anywhere else, which is the point.

### Testing

- Unit: coordinate normalization (0..360 to −180..180, latitude validation, antimeridian split),
  schema acceptance for a Moon and a Mars feature, rejection of an unknown body and an invalid
  coordinate, manifest schema, PMTiles metadata schema.
- Build, on the fixtures: the archive opens, metadata matches the manifest, a known tile exists, the
  ±180° and polar features survive, the hillshade tile is a valid PNG. No global download in CI. The
  build shells out to `tippecanoe` and `gdaldem`, both already required by `mailwoman coverage build`
  and `@mailwoman/spatial/tools/ogr`; a missing tool fails the test with the tool's name, never a skip.
- The DEM round-trip test (decode error at representative elevations within a stated bound) lands with
  the DEM product, not with v1.

## Definition of done

- `moon.pmtiles`, `moon-hillshade.pmtiles`, `mars.pmtiles`, `mars-hillshade.pmtiles` are published
  and answer at `tiles.mailwoman.ai`.
- Each body's `manifest.json` carries source checksums, coordinate conventions, and output checksums.
- The fixture build runs in CI in under a minute with no network.
- `@mailwoman/spatial` takes a body radius, with the Earth default unchanged for every existing caller.
- The workspace is registered in the root `workspaces`, both `tsconfig.json` reference pairs, and
  `SANCTIONED_RELEASE_ABSENCES`.

## Out of scope

Mission and landing-site data (a second source with its own provenance, after v1). Imagery mosaics.
The DEM archive and 3D terrain. Any change to the resolver or a `--body` flag on `mw geocode`.
