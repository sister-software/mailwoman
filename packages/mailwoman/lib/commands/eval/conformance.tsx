/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval conformance` — run the conformance-LAW suites: pairs of queries that differ by one
 *   declared transformation, each graded on the axis its own row names (entity identity, assembled
 *   coordinate, strict parse, component map, mechanism shape). Every suite in the register runs by default,
 *   with rows drawn from committed board cases and variants derived from those same queries by the named
 *   transformation. The laws are named by the register (`conformance/suites.ts`) rather than here: a list in
 *   this file is a second copy of it, and the copy is what goes stale.
 *
 *   Runs through the Gauntlet's own deps, so the pipeline under test is the one the board grades rather than a
 *   second assembly of it. Rows are audited before the engine loads; `status: pass` rows check the exit
 *   code, tracked rows report without blocking, and a tracked row that starts holding prints a promotion
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
		const { runConformanceCommand } = await import("#eval-harness/conformance/command")

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
