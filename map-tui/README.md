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
