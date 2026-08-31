/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Turn on Node's on-disk compile cache for this process — a CLI entry calls it first thing, so every later import is
 * served from the cache the previous run wrote.
 */
export { enableCompileCache } from "node:module"
