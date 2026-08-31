/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Codex operator tools — the `run()`-style modules behind `mailwoman dev generate …` commands. No
 *   argv, no `process.exit`: commands own parsing, rendering, and exit codes.
 */

export * from "#tools/generate-country-population"
export * from "#tools/generate-country-reference"
export * from "#tools/generate-official-languages"
