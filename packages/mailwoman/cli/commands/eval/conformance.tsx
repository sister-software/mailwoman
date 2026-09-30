/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval conformance` — run the conformance-LAW suites: pairs of queries that differ by one
 *   declared transformation. Each pair is graded on the axis its own row specifies (entity identity, assembled
 *   coordinate, strict parse, component map, mechanism shape). Every suite in the register runs by default,
 *   with rows drawn from committed board cases and variants derived from those same queries by the specified
 *   transformation. The register (`conformance/suites.ts`) defines the laws. This file contains a second list
 *   of those laws. The list can go stale.
 *
 *   Runs through the Gauntlet's own deps, so the pipeline under test is the one the board grades rather than a
 *   second assembly of it. Rows are audited before the engine loads; `status: pass` rows check the exit
 *   code. Tracked rows report without blocking. A tracked row that starts holding prints a promotion
 *   instruction.
 */

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Every committed conformance-law suite, through the Gauntlet's deps"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "conformance",
	description,
	options: {
		suite: { type: "string", description: "One law suite JSONL to run (default: every committed suite)" },
		candidate: { type: "string", description: "Candidate ONNX" },
		tokenizer: { type: "string", description: "Candidate tokenizer" },
		card: { type: "string", description: "Candidate model card" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		"candidate-db": { type: "string", description: "Candidate gazetteer artifact" },
	},
} as const satisfies CommandSpec

// The runner narrates its own report + verdict lines, so no `json` — rendering anything here would duplicate it.
const EvalConformance = harnessCommand(
	spec,
	async (options) => {
		const { runConformanceCommand } = await import("#tools/eval-harness/conformance/command")

		return runConformanceCommand({
			...(options.suite ? { suite: options.suite } : {}),
			...(options.candidate ? { modelPath: options.candidate } : {}),
			...(options.tokenizer ? { tokenizerPath: options.tokenizer } : {}),
			...(options.card ? { modelCardPath: options.card } : {}),
			...(options.weightsCache ? { weightsCacheRoot: options.weightsCache } : {}),
			...(options.candidateDB ? { candidateDB: options.candidateDB } : {}),
		})
	},
	{ exitCode: (exitCode) => exitCode }
)

export default EvalConformance
