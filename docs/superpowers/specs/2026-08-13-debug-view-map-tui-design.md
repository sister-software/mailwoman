# Interactive geocode debug view + `@mailwoman/map-tui`

- **Date:** 2026-08-13
- **Status:** Approved design, pre-implementation
- **Scope:** Phase 1 — `mw geocode "<address>" --debug` (interactive + static) backed by a new
  `@mailwoman/map-tui` library workspace. Phase 2 (the standalone full-screen `npx map-tui`
  browser) is out of scope here beyond the boundaries this design leaves for it.

## Motivation

The rules-based parser had a CLI debug mode (`debug/DebugOutputBuilder.ts`, last shipped at tag
0.3.0) that rendered each pipeline stage as color-coded spans. It was removed with the rules
parser. This design rebuilds the feature on the current stack as an Ink/Pastel three-panel view
over the neural geocode pipeline, with a terminal-rendered map of the result.

mapscii (MIT, archived at `~/Projects/mapscii`) showed that a braille vector-tile map works in a
terminal. `@sister.software/asciify` (4.1.0, published, `./tui` entry) replaces its renderer. The
asciify entry is a damage-diffed cell renderer with a braille 2×4 subpixel mode and a `setCell`
overlay path. This design reuses mapscii's concepts (vector-tile decode, styling, line and polygon
rasterization into braille, and collision-avoiding label placement) and reimplements them
clean-room against the protomaps basemap schema. No code is ported, so no MIT notice is carried.
If an algorithm is later ported verbatim, its notice must be carried with it.

## Decisions (operator-confirmed)

1. **Interaction model:** interactive alternate-screen Ink session. Pan/zoom the map, scroll the
   output pane, edit the input and re-run against the warm session. Quit with Esc/Ctrl+C.
2. **Debug depth:** parse spans + resolution. The output pane answers "what did it parse and
   where did it land": colored labeled spans, then tier / coordinate / uncertainty / hierarchy
   with attribution. Stage internals (query-shape, locale-hint, grouper hypotheses) are out of
   v1 scope.
3. **Build order:** `@mailwoman/map-tui` bootstraps first as a library-only workspace; the debug
   view is its first consumer. The standalone bin is phase 2. This order avoids building a
   throwaway map pane and extracting it later.
4. **Input editing:** editable in v1. Enter re-geocodes without reloading the model or reopening
   databases.
5. **Static rendering is first-class:** non-interactive consumers (a Claude skill shelling the
   command, CI, pipes) get a one-shot ANSI frame from the same component tree. This requirement
   drives the core architectural decision below.

## Architecture: frame-first rendering

`@mailwoman/map-tui`'s renderer produces a **frame value**, which is a cell grid convertible to
ANSI-styled lines. The renderer never writes to the terminal. The consumer owns the terminal:

| Consumer                                  | Presentation                                        |
| ----------------------------------------- | --------------------------------------------------- |
| `mw geocode --debug` (TTY)                | Ink app; map pane renders the frame as styled lines |
| `mw geocode --debug` (piped/Claude skill) | same component tree, one static frame to stdout     |
| `npx map-tui` (phase 2)                   | full-screen `AsciifyTerminal`, damage-diffed        |

The debug view is a pure Ink app (approach A of three considered). Ink repaints the whole map
pane on each pan, which is acceptable at pane sizes of about 60×25 cells. In exchange, the screen
has exactly one writer, and the static path is the same code rendered once. Two alternatives were
rejected. A hybrid where `AsciifyTerminal` owns the map region beside Ink would have two writers,
every Ink reflow would overwrite the pane, and the code would need `invalidate()` coordination
with the same fragility mapscii had. A raw-ANSI app without Ink would give up the layout, focus,
and input components that motivated this design. asciify's damage-diffing fits the phase-2
standalone browser.

## 1. `@mailwoman/map-tui` — the package

New workspace `map-tui/`, source at the workspace root per convention, published as
`@mailwoman/map-tui`. Presentation-free core. Modules:

- **`tile-source.ts`** — PMTiles v3 reader over the `pmtiles` npm package (protomaps' reference
  reader, zero-dep, BSD-3) plus a small node `FileSource` adapter doing `FileHandle.read` range
  reads, because the library ships only fetch-based sources. HTTP range sources can use the
  library's fetch-based sources later without new code. The module keeps an LRU cache of decoded tiles.
- **`mvt.ts`** — vector-tile decode via `@mapbox/vector-tile` + `pbf`.
- **`style.ts`** — one curated dark-terminal style table for the protomaps basemap schema:
  layer → `{kind: fill | line | label, color, minZoom, widthByZoom}` across the nine layers
  (`boundaries, buildings, earth, landcover, landuse, places, pois, roads, water` — verified
  against the lab dump `$MAILWOMAN_DATA_ROOT/tiles/planet.pmtiles`, z0–15 MVT gzip, planetiler
  build). The table is data-driven, and v1 has no theming engine.
- **`raster.ts`** — geometry rasterizer. It applies web-mercator projection, Bresenham
  polylines with width, scanline polygon fill, and viewport clipping into an RGBA subpixel buffer
  at asciify's braille interface (2×4 px per cell).
- **`frame.ts`** — the `MapFrame` frame value: columns, rows, char + color arrays
  (`Uint32Array` each), and the attribution string. `frameToANSILines(frame)` converts it for
  Ink/static embedding. Label and marker overlays are written as character cells with
  collision-avoiding placement, and text takes precedence over braille in the grid.
- **`renderer.ts`** — `MapRenderer`: viewport `{centerLat, centerLon, zoom, columns, rows}` →
  tile set → fetch/decode (cached) → rasterize → braille cells via asciify's exported braille
  primitives → overlays → `MapFrame`. Markers `{lat, lon, char, color}[]` plus an uncertainty
  ring (meters → px via `@mailwoman/spatial`).

Dependencies: `@sister.software/asciify` (`./tui` entry), `pmtiles`, `@mapbox/vector-tile`,
`pbf`, `@mailwoman/spatial`. No Ink anywhere in the core.

Rendering note: solid fills pass through asciify's Bayer ordered dither, so a fill color's
luminance sets its stipple density. Water renders as a dim texture and roads as solid bright
dots. The style table can tune this, so it is not a design risk.

Attribution: `MapFrame.attribution` carries the tile archive's attribution string. The dump is
OSM-derived, so display attribution is required. Consumers render it, and the debug pane shows it
bottom-right. No package ships tiles. The consumer always supplies the path.

## 2. Geocode session (mailwoman workspace)

Extract `runGeocode`'s dependency assembly (`mailwoman/commands/geocode.tsx`) into
`createGeocodeSession(options)`, a sibling of `geocode-core.ts`. The session loads the
classifier, opens the resolver backend, extract providers, placer, and poi deps once, and returns
`{geocode(input), close()}`. `geocode(input)` returns the flat `GeocodeResult` **plus** the
parsed tree and the classifier's labeled char spans (the sentencepiece native-offsets path
carries offsets end to end; the exact accessor is plan-time verification item 1).

The existing one-shot path becomes create → geocode → close in a try/finally and stays
byte-identical. `geocode.test.ts` must pass unmodified. The #1577 requirement also stays in
place: nothing on the non-debug success path renders through Ink, and output goes through
`writeRawStdout`.

## 3. The debug view (mailwoman workspace)

`--debug` on `geocode`. TTY stdout → interactive session; non-TTY → static frame (§4).
Components live in `mailwoman/debug-view/` (a sibling family to `cli-kit/`):

- **Layout** — Ink flexbox: `InputBar` full-width on top; beneath it `OutputPane` (50%) beside
  `MapPane` (50%). The session enters the alternate screen buffer and restores the screen on
  exit, so scrollback is never modified, as #1577 requires.
- **`InputBar`** — an editable line (`ink-text-input`, pending the plan-time dependency check)
  above a span ribbon. The ribbon echoes the input with a colored background segment per
  component tag and a legend beneath. Enter re-geocodes against the warm session, and a busy state
  shows while it runs (under a second once warm).
- **`OutputPane`** — tier, coordinate, `uncertainty_m`, then hierarchy rows (tag, value,
  placeID, coord) colorized. ↑/↓ scrolls when focused.
- **`MapPane`** — `MapRenderer` frame centered on the result; marker at the coordinate;
  uncertainty ring when `uncertainty_m` is present; attribution bottom-right. When focused:
  arrows pan, `+`/`-` zoom, `0` recenters on the result. Initial zoom by tier:
  `address_point`/`interpolated` ≈ z15; `admin` by leaf placetype (locality z11, region z6,
  country z4).
- **Focus** — Tab cycles input → output → map; the focused pane gets the highlighted border.
  Esc and Ctrl+C always quit; `q` quits except while the input is focused.
- **Degrade** — with no tile source, `MapPane` renders the marker on a graticule plus
  "no tiles: set `$MAILWOMAN_TILES` or `--tiles`". The pane distinguishes an unconfigured tile
  source from an empty tile (the meaning-of-zero rule).

Tiles path resolution (CLI layer, never inside map-tui): `--tiles <path>` flag →
`$MAILWOMAN_TILES` (new variable in `core/env/schema.ts`) → `dataRootPath("tiles",
"planet.pmtiles")` existence probe. On the lab host the protomaps dump symlinks into the data
root.

## 4. Static render interface

With `--debug` and a non-TTY stdout: render the same component tree once at
`--debug-size <cols>x<rows>` (default `120x36`), write one ANSI frame to stdout, and exit with
the normal geocode exit codes (0 for success including admin-only degradation, 1 for bad args,
a missing DB, or a fatal error). On a TTY the terminal size applies and the flag is ignored. ANSI
color is on by default, and `NO_COLOR` is honored. A Claude skill uses this path by running the
command with piped output and capturing the block, with no extra flag.

`--debug` combined with `--json` / `--text` / `--jsonld` / `--format` is a usage error, the same
pattern as the existing format-shorthand conflict in `resolveFormat`.

## 5. Workspace + publish mechanics

- `map-tui/` joins the root `workspaces` array (54 → 55) **and** the `.release-it.json` publish
  list in the same release that ships `--debug`. `mailwoman` gains a hard dependency on it, so
  the osm-style holdout is not available. An unpublished `workspace:*` dependency would break the
  published tarball.
- The first `@mailwoman/map-tui` publish cannot use Trusted Publishing OIDC because the package
  does not exist yet. The manual bless path applies once.
- In phase 2, `npx @mailwoman/map-tui` works from the scoped bin without extra setup. Reserving
  the unscoped `map-tui` npm name is a phase-2 product decision and is deferred.
- New workspace follows every standing convention: dev `exports` map only (publish map derived
  at pack time), `.ts` relative imports with `rewriteRelativeImportExtensions`,
  `erasableSyntaxOnly`, acronym casing, oxlint/oxfmt.

## 6. Testing

- **map-tui:** golden-frame tests render a committed fixture `.pmtiles` to text snapshots. The
  fixture is a `pmtiles extract` of one metro, size-checked before committing, with a target well
  under 1 MB. Braille output is deterministic because Bayer is a fixed matrix and the render path
  uses no randomness. Unit tests for mercator math, line/fill rasterization, style lookup, and label
  collision.
- **mailwoman:** the session refactor's regression check is the existing `geocode.test.ts`
  passing unmodified. Debug-view component tests run via `ink-testing-library` with a stubbed
  session (no model load). A static-frame smoke test runs where weights + gazetteer exist and
  asserts the frame carries the coordinate and braille content.

## Plan-time verification items

1. The exact accessor for labeled char spans out of the classify stage (native-offsets path).
   The span ribbon depends on it.
2. Ink static-frame mechanics on non-TTY stdout: confirm a single frame lands without cursor
   ops, or select the capture mechanism (`ink-testing-library`-style capture vs custom stdout).
3. Fixture `.pmtiles` size and extent before committing.
4. Whether asciify's exported braille primitives suffice for RGBA→cell conversion in a
   frame-value context, or a thin `AsciifyTerminal` subclass is needed.
5. Whether `tile-worker/` already carries z/x/y tile math worth hoisting into
   `@mailwoman/spatial` instead of writing new mercator code (duplication check).
6. `ink-text-input` dependency hygiene (ESM, maintenance state) vs a hand-rolled input on
   `useInput`.

## Out of scope (phase 2 and later)

- The standalone `npx map-tui` full-screen browser (AsciifyTerminal presentation, pan/zoom the
  planet, possibly geocode-powered search).
- Fresh tileset generation via tippecanoe from OSM extracts.
- Full pipeline stage trace in the output pane (the pane is structured as sections, so stages
  can light up later without a layout change).
- HTTP/R2-hosted tile sources for users without a local planet file.
