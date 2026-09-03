# Interactive geocode debug view + `@mailwoman/map-tui`

- **Date:** 2026-08-13
- **Status:** Approved design, pre-implementation
- **Scope:** Phase 1 — `mw geocode "<address>" --debug` (interactive + static) backed by a new
  `@mailwoman/map-tui` library workspace. Phase 2 (the standalone full-screen `npx map-tui`
  browser) is out of scope here beyond the boundaries this design leaves for it.

## Motivation

The rules-based parser had a CLI debug mode (`debug/DebugOutputBuilder.ts`, last shipped at tag
0.3.0) that rendered each pipeline stage as color-coded spans. It died with the rules parser. This
design revives its spirit on the current stack: an Ink/Pastel three-panel view over the neural
geocode pipeline, with a terminal-rendered map of the result.

mapscii (MIT, archived at `~/Projects/mapscii`) proved a braille vector-tile map in a terminal
works. Its renderer is superseded by `@sister.software/asciify` (4.1.0, published, `./tui` entry:
damage-diffed cell renderer with braille 2×4 subpixel mode and a `setCell` overlay path). What
survives from mapscii is the concept set — vector-tile decode, styling, line/polygon
rasterization into braille, collision-avoiding label placement — reimplemented clean-room against
the protomaps basemap schema. No code is ported; no MIT notice is carried. If an algorithm is
later ported verbatim, the notice travels with it.

## Decisions (operator-confirmed)

1. **Interaction model:** interactive alternate-screen Ink session. Pan/zoom the map, scroll the
   output pane, edit the input and re-run against the warm session. Quit with Esc/Ctrl+C.
2. **Debug depth:** parse spans + resolution. The output pane answers "what did it parse and
   where did it land": colored labeled spans, then tier / coordinate / uncertainty / hierarchy
   with attribution. Stage internals (query-shape, locale-hint, grouper hypotheses) are out of
   v1 scope.
3. **Build order:** `@mailwoman/map-tui` bootstraps first as a library-only workspace; the debug
   view is its first consumer. The standalone bin is phase 2. No throwaway map pane, no
   extraction churn.
4. **Input editing:** editable in v1. Enter re-geocodes without reloading the model or reopening
   databases.
5. **Static rendering is first-class:** non-interactive consumers (a Claude skill shelling the
   command, CI, pipes) get a one-shot ANSI frame from the same component tree. This requirement
   drives the core architectural decision below.

## Architecture: frame-first rendering

`@mailwoman/map-tui`'s renderer produces a **frame value** — a cell grid convertible to
ANSI-styled lines — and never touches the terminal. Terminal ownership lives in the consumer:

| Consumer                                  | Presentation                                        |
| ----------------------------------------- | --------------------------------------------------- |
| `mw geocode --debug` (TTY)                | Ink app; map pane renders the frame as styled lines |
| `mw geocode --debug` (piped/Claude skill) | same component tree, one static frame to stdout     |
| `npx map-tui` (phase 2)                   | full-screen `AsciifyTerminal`, damage-diffed        |

The debug view is a pure Ink app (approach A of three considered). Ink repaints the map pane
wholesale on pan — acceptable at pane sizes (~60×25 cells) — and in exchange there is exactly one
writer on the screen, and the static path is the same code rendered once. The rejected
alternatives: a hybrid where `AsciifyTerminal` owns the map region beside Ink (two writers, every
Ink reflow clobbers the pane, `invalidate()` choreography — mapscii-era fragility), and a no-Ink
raw-ANSI app (forfeits the layout/focus/input components that motivated this). asciify's
damage-diffing is not wasted: it is the natural presentation for the phase-2 standalone browser.

## 1. `@mailwoman/map-tui` — the package

New workspace `map-tui/`, source at the workspace root per convention, published as
`@mailwoman/map-tui`. Presentation-free core. Modules:

- **`tile-source.ts`** — PMTiles v3 reader over the `pmtiles` npm package (protomaps' reference
  reader, zero-dep, BSD-3) plus a small node `FileSource` adapter doing `FileHandle.read` range
  reads (the lib ships only fetch-based sources). HTTP range sources come free later. LRU cache
  of decoded tiles.
- **`mvt.ts`** — vector-tile decode via `@mapbox/vector-tile` + `pbf`.
- **`style.ts`** — one curated dark-terminal style table for the protomaps basemap schema:
  layer → `{kind: fill | line | label, color, minZoom, widthByZoom}` across the nine layers
  (`boundaries, buildings, earth, landcover, landuse, places, pois, roads, water` — verified
  against the lab dump `/mnt/playpen/protomaps/20260521.pmtiles`, z0–15 MVT gzip, planetiler
  build). Data-driven; no theming engine in v1.
- **`raster.ts`** — geometry rasterizer: web-mercator projection, Bresenham polylines with
  width, scanline polygon fill, viewport clip — into an RGBA subpixel buffer at asciify's
  braille contract (2×4 px per cell).
- **`frame.ts`** — the `MapFrame` frame value: columns, rows, char + color arrays
  (`Uint32Array` each), and the attribution string. `frameToANSILines(frame)` converts it for
  Ink/static embedding; label and marker overlays land as character cells with
  collision-avoiding placement (text beats braille in the grid).
- **`renderer.ts`** — `MapRenderer`: viewport `{centerLat, centerLon, zoom, columns, rows}` →
  tile set → fetch/decode (cached) → rasterize → braille cells via asciify's exported braille
  primitives → overlays → `MapFrame`. Markers `{lat, lon, char, color}[]` plus an uncertainty
  ring (meters → px via `@mailwoman/spatial`).

Dependencies: `@sister.software/asciify` (`./tui` entry), `pmtiles`, `@mapbox/vector-tile`,
`pbf`, `@mailwoman/spatial`. No Ink anywhere in the core.

Rendering note: solid fills pass through asciify's Bayer ordered dither, so a fill color's
luminance sets its stipple density — water reads as dim texture, roads as solid bright dots.
This is a style-table tuning knob, not a design risk.

Attribution: `MapFrame.attribution` carries the tile archive's attribution string (the dump is
OSM-derived; display attribution is required). Consumers render it — the debug pane shows it
bottom-right. Tiles are never shipped with any package; the path always comes from the consumer.

## 2. Geocode session (mailwoman workspace)

Extract `runGeocode`'s dependency assembly (`mailwoman/commands/geocode.tsx`) into
`createGeocodeSession(options)`, a sibling of `geocode-core.ts`. The session loads the
classifier, opens the resolver backend, extract providers, placer, and poi deps once, and returns
`{geocode(input), close()}`. `geocode(input)` returns the flat `GeocodeResult` **plus** the
parsed tree and the classifier's labeled char spans (the sentencepiece native-offsets path
carries offsets end to end; the exact accessor is plan-time verification item 1).

The existing one-shot path becomes create → geocode → close in a try/finally and stays
byte-identical: `geocode.test.ts` must pass unmodified, and the #1577 contract — nothing on the
non-debug success path renders through Ink; output goes through `writeRawStdout` — is untouched.

## 3. The debug view (mailwoman workspace)

`--debug` on `geocode`. TTY stdout → interactive session; non-TTY → static frame (§4).
Components live in `mailwoman/debug-view/` (a sibling family to `cli-kit/`):

- **Layout** — Ink flexbox: `InputBar` full-width on top; beneath it `OutputPane` (50%) beside
  `MapPane` (50%). The session enters the alternate screen buffer and restores on exit —
  scrollback is untouched by construction, honoring the #1577 lesson.
- **`InputBar`** — editable line (`ink-text-input`, pending plan-time dep check) above a span
  ribbon: the input echoed with colored background segments per component tag, legend beneath.
  Enter re-geocodes against the warm session; a busy state shows while running (sub-second once
  warm).
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
  "no tiles: set `$MAILWOMAN_TILES` or `--tiles`". Unconfigured is distinguished from an empty
  tile (meaning-of-zero rule).

Tiles path resolution (CLI layer, never inside map-tui): `--tiles <path>` flag →
`$MAILWOMAN_TILES` (new variable in `core/env/schema.ts`) → `dataRootPath("tiles",
"planet.pmtiles")` existence probe. On the lab host the playpen dump symlinks into the data
root.

## 4. Static render contract

With `--debug` and a non-TTY stdout: render the same component tree once at
`--debug-size <cols>x<rows>` (default `120x36`; the flag is ignored on a TTY where the terminal
size rules), write one ANSI frame to stdout, exit with the normal geocode exit codes (0 success
including admin-only degradation, 1 bad args / missing DB / fatal error). ANSI color is on by
default; `NO_COLOR` is honored. This is the Claude-skill surface: shell the command piped and
capture the block — no extra flag.

`--debug` combined with `--json` / `--text` / `--jsonld` / `--format` is a usage error, the same
pattern as the existing format-shorthand conflict in `resolveFormat`.

## 5. Workspace + publish mechanics

- `map-tui/` joins the root `workspaces` array (54 → 55) **and** the `.release-it.json` publish
  list in the same release that ships `--debug`. `mailwoman` gains a hard dependency on it, so
  the osm-style holdout is not available — an unpublished `workspace:*` dep breaks the published
  tarball.
- The first `@mailwoman/map-tui` publish cannot use Trusted Publishing OIDC (first-publish gap):
  the manual bless path applies once.
- `npx @mailwoman/map-tui` works from the scoped bin for free in phase 2; reserving the unscoped
  `map-tui` npm name is a phase-2 product decision, deferred.
- New workspace follows every standing convention: dev `exports` map only (publish map derived
  at pack time), `.ts` relative imports with `rewriteRelativeImportExtensions`,
  `erasableSyntaxOnly`, acronym casing, oxlint/oxfmt.

## 6. Testing

- **map-tui:** golden-frame tests — a committed fixture `.pmtiles` (a `pmtiles extract` of one
  metro; size-checked before committing, target well under 1 MB) rendered to text snapshots.
  Braille output is deterministic (Bayer is a fixed matrix; no randomness anywhere in the
  render path). Unit tests for mercator math, line/fill rasterization, style lookup, and label
  collision.
- **mailwoman:** the session refactor's regression check is the existing `geocode.test.ts`
  passing unmodified. Debug-view component tests run via `ink-testing-library` with a stubbed
  session (no model load). A static-frame smoke test runs where weights + gazetteer exist and
  asserts the frame carries the coordinate and braille content.

## Plan-time verification items

1. The exact accessor for labeled char spans out of the classify stage (native-offsets path) —
   the span ribbon depends on it.
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
