# @mailwoman/map-tui

A frame-first terminal map renderer. It decodes vector tiles from a
[PMTiles](https://protomaps.com/) archive, rasterizes the visible layers, and
resolves the result to a grid of terminal cells — braille-glyph map frames
suitable for TUIs and other character-grid displays.

The unit of output is a `MapFrame`: frames are values, not side effects.
Rendering never writes to stdout, an Ink component, or any other presentation
layer directly — a caller reads the frame's cells and decides how (and
whether) to draw them.

Tiles are never bundled with this package. Every render takes a caller-supplied
PMTiles path (local file or remote archive), so callers own their own tile
sourcing and coverage.

## The browser

The package also ships `map-tui`, a full-screen interactive map for the
terminal — the library's own frames, driven by a keyboard and a mouse.

```sh
npx @mailwoman/map-tui --tiles planet.pmtiles
```

It opens on the alternate screen, so your scrollback is untouched, and puts the
terminal back exactly as it found it on the way out — including after `Ctrl+C`.

### Keys

| Key                  | Does                          |
| -------------------- | ----------------------------- |
| `←` `↑` `↓` `→`      | Pan an eighth of the viewport |
| `h` `j` `k` `l`      | Pan, for vim hands            |
| `+` `=` `a`          | Zoom in one level             |
| `-` `_` `z`          | Zoom out one level            |
| `q`, `Esc`, `Ctrl+C` | Quit                          |

### Mouse

If your terminal reports mouse events, the wheel zooms toward the pointer,
dragging pans, and a click centers the map on the cell you clicked.

### Flags

| Flag                  | Does                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--tiles <path\|url>` | PMTiles archive — a local path or an `https://` URL read via range requests. Defaults to `$MAILWOMAN_TILES`. |
| `--lat <deg>`         | Initial center latitude (default `0`).                                                                       |
| `--lon <deg>`         | Initial center longitude (default `0`).                                                                      |
| `--zoom <level>`      | Initial zoom, 0–24 (default `2` — a world view).                                                             |
| `--help`, `-h`        | Print the flags and key bindings.                                                                            |
| `--version`, `-v`     | Print the package version.                                                                                   |

### Where to get an archive

Protomaps publishes daily planet builds and a region extractor at
[protomaps.com/downloads](https://protomaps.com/downloads). Any PMTiles archive
with the [protomaps-basemap](https://github.com/protomaps/basemaps) layer names
(`earth`, `water`, `roads`, `boundaries`, `places`, …) renders; other schemas
decode fine but draw only the layers this package styles.

Working in this repo, the committed test fixture — a hand-authored slice of
southeast Portland — is enough to see the browser run without downloading
anything:

```sh
node map-tui/out/cli.js \
  --tiles map-tui/test/fixtures/portland.pmtiles \
  --lat 45.5034 --lon -122.6023 --zoom 12
```

The fixture is not published: `test/` stays out of the tarball, so an installed
copy needs a real archive.
