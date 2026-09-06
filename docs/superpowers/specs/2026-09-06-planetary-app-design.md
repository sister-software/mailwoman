# Planetary: `moon.mailwoman.ai` and `mars.mailwoman.ai`

**Status:** design approved 2026-09-06. Decisions the operator took: one app, `packages/planetary`, built twice;
`planetary` is the conventional umbrella term in planetary cartography and covers the Moon; separate `moon` and
`mars` workspaces only if their implementations diverge.
**Builds on:** `2026-09-06-earth-app-design.md` (the Vite, PWA and Workers Builds shape, and `MapCanvas` in
`@mailwoman/react/map`) and `2026-09-06-astrogeology-pipeline-design.md` (the archives it renders).
**Supersedes:** the application half of the uploaded "Planetary Maps for Mailwoman" proposal.

## The problem

The map primitives the repository already has (`MapCanvas`, the `StyleSpecificationComposer` in
`@mailwoman/cartographer`, the PMTiles tile worker, `mailwoman tiles publish`) are Earth-only by
accident of use, not by design. Two small map products over a different body are the cheapest way to
find out which of them assume Earth, and they are products in their own right.

## Decisions taken

**One source, two builds.** `PLANETARY_BODY=moon` and `PLANETARY_BODY=mars` are build variables in two
Workers Builds projects over the same root directory. Each build emits its own manifest, service worker,
icons, theme and body config. The host is canonical in production; no query parameter switches the body.

**Private workspace under `packages/`.** `packages/planetary`, `@mailwoman/planetary`, `private: true`,
in `SANCTIONED_RELEASE_ABSENCES` with "private planetary map app — Cloudflare infrastructure, never
publishes".

**No Earth switcher, no geocoder, no application Worker.** v1 is a browsable globe with labels, a
feature panel, search, and deep links.

**Body is explicit.** `PlanetaryBodyID` from `@mailwoman/astrogeology` is the only body type; nothing
treats Earth as the implicit reference.

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
`@mailwoman/core/env`, never `process.env` directly. Production host and built body are checked at
startup: a mismatch renders an error page, not the wrong body.

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
over the existing `StyleSpecificationComposer`, with its own base layers and no Protomaps Earth layer.
Layer order: background, neutral body fill, hillshade, nomenclature polygons and lines, nomenclature
labels, selection highlight. Labels are styled by feature type (regions, maria and planitiae, montes,
valles, craters) and decluttered by zoom against `diameterKm`: a larger feature appears at a lower zoom.
Moon is dark with grayscale terrain; Mars is dark with rust terrain. Neither `base/theme.ts` nor the
Earth sprite at `public.mailwoman.ai/protomaps/sprites/v4/light` is touched; planetary styles use no
sprite in v1.

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

No new route, no Moon- or Mars-specific worker code.

### Map

`MapCanvas` from `@mailwoman/react/map` with `projection: "globe"`, the injected style, and the body's
initial view (Moon at 0°, 0°; Mars centred on Tharsis, both checked visually). Pan, zoom and rotate come
from the shell. A click on a nomenclature feature selects it, opens the panel, and pushes
`/feature/<id>` to history without a reload. Fly-to respects `prefers-reduced-motion`. MapLibre's globe
is a rendering model, not a geodesy engine; the app makes no distance or area claim in v1, and when it
does, it calls `@mailwoman/spatial` with the body radius the pipeline's `bodies.ts` supplies.

### Search

The pipeline builds an `@mailwoman/ancestrie` artifact per body over feature names and their aliases
(`Sea of Tranquility` for `Mare Tranquillitatis`). The app fetches it once, walks it with the
browser-safe reader, and lists results with feature type; results are keyboard navigable, and selecting
one moves the camera and selects the feature. The artifact is a static asset served by the app, not a
tile.

### PWA

Same shape as Earth: `vite-plugin-pwa`, a precache of the shell, hashed assets, icons, the body config
and the search artifact; never a PMTiles archive. Manifest identity per build:

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

Generated from the pipeline manifest: USGS Astrogeology, the IAU Working Group for Planetary System
Nomenclature, the NASA mission and instrument for each terrain product, MapLibre. Always visible.

### Testing

- Unit: body config selection from `PLANETARY_BODY`; `moon.mailwoman.ai` and `mars.mailwoman.ai` map
  to their bodies; an unknown production host fails explicitly; route parsing for `/feature/<id>`.
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
- No application Worker script exists; no docs import; no new tile server.
- `packages/planetary` is registered in the root `workspaces`, both `tsconfig.json` reference pairs, and
  `SANCTIONED_RELEASE_ABSENCES`; the tile worker CORS list carries both origins.

## Out of scope

3D terrain and the DEM archive, imagery, mission sites and traverses, and any `mw geocode --body`
integration. Each is a later design over the same primitives.
