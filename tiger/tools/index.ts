/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   TIGER operator tools — the `run()`-style modules behind `mailwoman tiger race-dots` /
 *   `race-dots-map` (see the 2026-07-09 scripts→Pastel spec). No argv, no `process.exit`: commands
 *   own parsing, rendering, and exit codes. Heavy deps (`@turf/boolean-contains`,
 *   `@protomaps/basemaps`) are lazy-imported inside their entry fns. NOT `sdk/` — that submodule
 *   means data acquisition.
 */

export * from "./race-dots.ts"
export * from "./race-dots-map.ts"
export * from "./serve-range.ts"
