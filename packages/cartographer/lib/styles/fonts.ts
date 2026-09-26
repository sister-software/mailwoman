/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The glyph stacks a symbol layer may name. MapLibre draws no text when a glyph range answers 404, so a `text-font`
 *   naming an absent stack blanks every label in the style with no console error a reader would connect to it. The
 *   mirror behind `PROTOMAPS_GLYPHS_URL` serves `Noto Sans Regular`, `Noto Sans Medium`, `Noto Sans Italic`,
 *   `Fira Code Regular` and `Fira Code Medium` — and no `Open Sans Regular`, which is MapLibre's own default. Name a
 *   constant from this file rather than a string literal.
 */

/**
 * The regular text stack: body labels, point features, place names.
 */
export const PROTOMAPS_FONT_REGULAR = "Noto Sans Regular"
