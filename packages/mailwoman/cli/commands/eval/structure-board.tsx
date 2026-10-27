/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval structure-board`: the held-out structure board of #2857. WOF structure cells kept out of every
 *   training arm, query shapes, relation-word pairs, mixed-script venues, romaji in Western order and typos, with
 *   confidence intervals per class and per minimal pair. Informational: always exits 0.
 */

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Held-out structure board — unseen orders, query shapes, pairs and typos with CIs (#2857)"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "structure-board",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale (default en-US)" },
		"weights-cache": {
			type: "string",
			description: "Package-shaped candidate weights dir (mirrors eval parity --weights-cache)",
		},
		fixtures: { type: "string", description: "Fixture JSONL override (default: the held-out structure board)" },
		klass: { type: "string", description: "Score only one class (e.g. relation-pair) for a fast loop" },
	},
} as const satisfies CommandSpec

// The runner narrates its table on stdout, so no `json`.
const EvalStructureBoard = harnessCommand(
	spec,
	async (options) => {
		const { runStructureBoard } = await import("#tools/eval-harness/structure-board")

		return (
			await runStructureBoard({
				locale: options.locale,
				weightsCacheRoot: options.weightsCache,
				fixturesPath: options.fixtures,
				klass: options.klass,
			})
		).exitCode
	},
	{ exitCode: (exitCode) => exitCode }
)

export default EvalStructureBoard
