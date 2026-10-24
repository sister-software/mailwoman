/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Longest accepted address input, in characters.
 *
 * The classifier reads a 128-piece SentencePiece window, roughly 330 Latin-script characters.
 * The larger bound leaves room for denser scripts and form prefixes while refusing a body whose
 * tail the parser would discard and whose preprocessing would occupy Node's request thread.
 */
export const MAX_ADDRESS_LENGTH = 1024

/**
 * Most bias points one geocode request may hold.
 *
 * A browser sends the viewport center and the device location, and the API Worker adds the
 * request's approximate location, so three points cover every caller this repository has.
 * The bound keeps the resolver's per-candidate distance work small for a request that sends more.
 */
export const MAX_BIAS_POINTS = 8
