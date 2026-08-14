/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The POI build's tunable defaults, and NOTHING else — no imports, so the module is free to load.
 *
 *   They live apart from the builders that consume them so command specifications can interpolate the defaults without
 *   importing DuckDB, h3-js, or the resolver schema layer. The builders re-export the names, so callers need not know
 *   where the constants live.
 */

/**
 * Pinned Overture release for the places-theme ingest. Matches `overture-ingest.tsx`'s own `DEFAULT_RELEASE` pin (the
 * addresses-theme ingest) as of this writing — a monthly Overture release covers every theme at once, so the two pins
 * move together in practice. Kept as an INDEPENDENT constant here rather than imported from that `.tsx` command:
 * `gazetteer-pipeline/*.ts` must stay importable under plain `node` type-stripping (no JSX transform), and
 * `commands/**\/*.tsx` files are Ink presentation that require compiling (AGENTS.md) — pulling a value FROM a `.tsx`
 * file into this pipeline layer would invert that dependency direction. If the pins drift, `--release` overrides either
 * independently.
 */
export const DEFAULT_RELEASE = "2026-05-20.0"

/**
 * `--min-rows` default — keeps the table to real chains, not one-off name collisions (~low-thousands of entries).
 */
export const DEFAULT_MIN_ROWS = 25

/**
 * `--dominance` default — a QID's modal name must cover at least this fraction of its total rows to qualify. Below the
 * floor, the QID is systematically mistagged (many unrelated chains sharing one Wikidata QID, e.g. Q4835981's "CVS"
 * over ~20 unrelated chains) rather than one real chain with noisy alias spellings — dropped entirely, not just demoted
 * out of the alias list the way sub-noise-floor variants are.
 */
export const DEFAULT_DOMINANCE = 0.5
