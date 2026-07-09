/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Corpus operator tools — the `run()`-style modules behind `mailwoman corpus …` commands. No argv,
 *   no `process.exit`: commands own parsing, rendering, and exit codes (see the 2026-07-09
 *   scripts→Pastel spec).
 */

export * from "./audit.ts"
export * from "./fetch/download.ts"
