/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Core operator tools — the `run()`-style modules behind `mailwoman dev generate …` commands. No
 *   argv, no `process.exit`: commands own parsing, rendering, and exit codes (see the 2026-07-09
 *   scripts→Pastel spec).
 */

export * from "./generate-language-types.ts"
