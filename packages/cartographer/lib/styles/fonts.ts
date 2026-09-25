/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The glyph stacks a symbol layer may name. MapLibre draws no text at all when a glyph range answers 404 — not a
 *   fallback face and no glyph — so a `text-font` naming an absent stack blanks every label in the style at every zoom,
 *   with no console error a reader would connect to the missing labels.
 *
 *   The mirror behind `PROTOMAPS_GLYPHS_URL` serves five stacks: `Noto Sans Regular`, `Noto Sans Medium`,
 *   `Noto Sans Italic`, `Fira Code Regular` and `Fira Code Medium`. It serves no Fira Sans, and no
 *   `Open Sans Regular` — which is MapLibre's own default, so a symbol layer that omits `text-font` also draws
 *   no text. Name a constant from this file rather than a string literal.
 */

/**
 * The regular text stack: body labels, point features, place names.
 */
export const PROTOMAPS_FONT_REGULAR = "Noto Sans Regular"
