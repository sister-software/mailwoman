/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/formatter` — the inverse of the parser.
 *
 *   - {@linkcode formatAddress} / {@linkcode formatFromClassificationMap}: components → idiomatic,
 *       locale-aware address string (for display and corpus synthesis).
 *   - {@linkcode canonicalKey}: components → a normalized, deterministic match key (for the matcher's
 *       blocking stage).
 */

export * from "./format.js"
export * from "./key.js"
