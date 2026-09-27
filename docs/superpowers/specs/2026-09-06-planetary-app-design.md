# Planetary: `moon.mailwoman.ai` and `mars.mailwoman.ai`

**Status:** design approved 2026-09-06. The operator decided on one app, `packages/planetary`, built twice. The
name `planetary` is the conventional umbrella term in planetary cartography and covers the Moon. Separate `moon` and
`mars` workspaces will exist only if their implementations diverge.
**Builds on:** `2026-09-06-earth-app-design.md` (the Vite, PWA and Workers Builds shape, and `MapCanvas` in
`@mailwoman/react/map`) and `2026-09-06-astrogeology-pipeline-design.md` (the archives it renders).
**Supersedes:** the application half of the uploaded "Planetary Maps for Mailwoman" proposal.
**Receipt:** PR #2209 opened 2026-09-08 over the archives published as moon `20260907-109dfab8` and mars
`20260907-e60bcc6a`. Creating the two Workers Builds projects is the dashboard step, and the public bucket's CORS rule
already admits both production origins. The preview serves on port 7770, the one local origin that rule admits.

## The problem

The map primitives the repository already has (`MapCanvas`, the `StyleSpecificationComposer` in
`@mailwoman/cartographer`, the PMTiles tile worker, `mailwoman tiles publish`) are Earth-only because
they have only been used for Earth, rather than by design. Two small map products over other bodies are the
cheapest way to find out which of them assume Earth, and they are products in their own right.

## Decisions taken

**One source, two builds.** `PLANETARY_BODY=moon` and `PLANETARY_BODY=mars` are build variables in two
Workers Builds projects over the same root directory. Each build emits its own manifest, service worker,
icons, theme and body config. In production the host determines the body, and no query parameter can
switch it.

**Private workspace under `packages/`.** The workspace is `packages/planetary` (`@mailwoman/planetary`,
`private: true`), listed in `SANCTIONED_RELEASE_ABSENCES` with "private planetary map app — Cloudflare
infrastructure, never publishes".

**v1 omits an Earth switcher, a geocoder, and an application Worker.** v1 is a browsable globe with
labels, a feature panel, search, and deep links.

**The body is always explicit.** `PlanetaryBodyID` from `@mailwoman/astrogeology` is the only body type,
and no code treats Earth as the implicit reference.

## Design

### Workspace

```text
packages/planetary/
  package.json          @mailwoman/planetary, private
  tsconfig.json, tsconfig.test.json
  vite.config.ts        reads PLANETARY_BODY; refuses an unknown value
  wrangler.toml         [assets] only; the Workers project name and custom domain come from the dashboard per body
  index.html
  lib/
    main.tsx
    App.tsx
    bodies/
      index.ts          PlanetaryMapConfig per body: title, hostname, initialView, tiles, manifest identity
      moon.ts
      mars.ts
    routes.ts           "/" and "/feature/<id>"; optional ?lon=&lat=&z= viewport
    search/             loads the ancestrie artifact the pipeline built; prefix and normalized-text match over names and aliases
    panels/             FeaturePanel (semantic HTML: name, type, coordinates, diameter, origin, approval, source), Attribution
    styles/
  test/
  public/               icons per body, selected at build
```

`vite.config.ts` reads `PLANETARY_BODY` through a typed `lib/env.ts` whose `liveEnv` view extends
`@mailwoman/core/env`, never `process.env` directly. The app compares the production host with the
built body at startup, and a mismatch renders an error page rather than the wrong body.

### Build and deployment

Two Workers Builds projects, `mailwoman-moon` and `mailwoman-mars`, with identical settings except the
build variable and the custom domain:

| Setting        | Value                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Root directory | `packages/planetary`                                                                                 |
| Build command  | `yarn build`                                                                                         |
| Build variable | `PLANETARY_BODY=moon` or `PLANETARY_BODY=mars`                                                       |
| Deploy command | `npx wrangler deploy`                                                                                |
| Watch paths    | `packages/planetary/**`, `packages/react/**`, `packages/cartographer/**`, `packages/astrogeology/**` |

`build.json` carries `body`, `revision`, `buildTime`, and the tileset versions from the pipeline
manifests the build was pointed at.

### Style

`packages/cartographer/lib/planetary/` holds `createPlanetaryStyle({ body, nomenclatureSource, hillshadeSource? })`
over the existing `StyleSpecificationComposer`, with its own base layers and without a Protomaps Earth
layer. The layer order is background, neutral body fill, hillshade, nomenclature polygons and lines,
nomenclature labels, and selection highlight. Labels are styled by feature type (regions, maria and
planitiae, montes, valles, craters) and decluttered by zoom against `diameterKm`, so a larger feature
appears at a lower zoom. The Moon is dark with grayscale terrain, and Mars is dark with rust terrain.
The design leaves `base/theme.ts` and the Earth sprite at
`public.mailwoman.ai/protomaps/sprites/v4/light` unchanged, and planetary styles use no sprite in v1.

### Tiles

The app reads TileJSON from the tile worker's existing route shape:

```ts
const tiles = {
	moon: {
		nomenclature: "https://tiles.mailwoman.ai/moon.json",
		hillshade: "https://tiles.mailwoman.ai/moon-hillshade.json",
	},
	mars: {
		nomenclature: "https://tiles.mailwoman.ai/mars.json",
		hillshade: "https://tiles.mailwoman.ai/mars-hillshade.json",
	},
}
```

The tile worker needs no new route and no Moon- or Mars-specific code.

### Map

`MapCanvas` from `@mailwoman/react/map` with `projection: "globe"`, the injected style, and the body's
initial view (Moon at 0°, 0°; Mars centred on Tharsis, both checked visually). Pan, zoom and rotate come
from the shell. A click on a nomenclature feature selects it, opens the panel, and pushes
`/feature/<id>` to history without a reload. Fly-to respects `prefers-reduced-motion`. MapLibre's globe
is a rendering model rather than a geodesy engine. The app makes no distance or area claim in v1. When it
does, it will call `@mailwoman/spatial` with the body radius the pipeline's `bodies.ts` supplies.

### Search

The pipeline builds an `@mailwoman/ancestrie` artifact per body over feature names and their aliases
(`Sea of Tranquility` for `Mare Tranquillitatis`). The app fetches it once, walks it with the
browser-safe reader, and lists results with their feature type. Results are keyboard navigable, and
selecting one moves the camera and selects the feature. The app serves the artifact as a static asset
rather than as a tile.

### PWA

The PWA follows the Earth app. It uses `vite-plugin-pwa` and precaches the shell, hashed assets, icons,
the body config and the search artifact, but never a PMTiles archive. Manifest identity per build:

```json
{
	"id": "https://moon.mailwoman.ai/",
	"name": "Mailwoman Moon",
	"short_name": "Moon",
	"start_url": "/",
	"scope": "/",
	"display": "standalone"
}
```

Separate origins keep the three bodies' service workers and caches apart by construction.

### Attribution

The attribution is generated from the pipeline manifest: USGS Astrogeology, the IAU Working Group for
Planetary System Nomenclature, the NASA mission and instrument for each terrain product, and MapLibre. It
is always visible.

### Testing

- Unit: body config selection from `PLANETARY_BODY`, `moon.mailwoman.ai` and `mars.mailwoman.ai`
  mapping to their bodies, an unknown production host failing explicitly, and route parsing for
  `/feature/<id>`.
- `createPlanetaryStyle` returns a valid `StyleSpecification` for each body, validated with
  `@maplibre/maplibre-gl-style-spec`.
- Playwright smoke over fixture tiles served locally: each body's page loads, MapLibre initializes,
  the right style is selected, search finds a fixture feature, selecting it moves the camera, a deep
  link restores the selection.
- Production smoke after deploy: both hosts, `/build.json`, both manifests, TileJSON, a low-zoom and a
  high-zoom tile, a `Range` request, CORS from each origin.

## Definition of done

- `moon.mailwoman.ai` and `mars.mailwoman.ai` serve globes over their published nomenclature and
  hillshade archives, with labels decluttered by scale, a feature panel, search, stable feature URLs,
  and visible attribution.
- Both are separate installable PWAs built from one source, with distinct identities and caches.
- No application Worker script, docs import, or new tile server exists.
- `packages/planetary` is registered in the root `workspaces`, both `tsconfig.json` reference pairs, and
  `SANCTIONED_RELEASE_ABSENCES`; the tile worker CORS list carries both origins.

## Out of scope

3D terrain and the DEM archive, imagery, mission sites and traverses, and any `mw geocode --body`
integration are out of scope. Each is a later design over the same primitives.
