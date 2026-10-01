/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The glyph stacks a symbol layer may name. MapLibre draws no text when a glyph range answers 404, so a `text-font`
 *   naming an absent stack blanks every label in the style with no console error a reader would connect to it. The
 *   mirror behind `PROTOMAPS_GLYPHS_URL` serves `Bliss Pro Regular`, `Bliss Pro Medium`, `Bliss Pro Italic`,
 *   `Fira Code Regular` and `Fira Code Medium` — and no `Open Sans Regular`, which is MapLibre's own default. Name a
 *   constant from this file rather than a string literal.
 *
 *   MapLibre requests one fontstack per URL, so a `text-font` list cannot fall back across files on a static bucket.
 *   Each Bliss Pro stack therefore carries Bliss Pro's Latin, Greek and Cyrillic glyphs merged over the Noto Sans
 *   glyphs of the same style, and a label in any other script draws from the Noto glyphs inside the same file.
 */

/**
 * The regular text stack: body labels, point features, place names.
 */
export const MAP_FONT_REGULAR = "Bliss Pro Regular"

/**
 * The emphasized text stack: major place names and road shields.
 */
export const MAP_FONT_MEDIUM = "Bliss Pro Medium"

/**
 * The italic text stack: water and natural-feature names.
 */
export const MAP_FONT_ITALIC = "Bliss Pro Italic"
