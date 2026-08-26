/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval conformance` — run a CONFORMANCE-LAW suite: pairs of queries that differ by one
 *   declared transformation, each graded on the axis its own row names (entity identity, assembled
 *   coordinate, strict parse, component map, mechanism shape). Default suite is the case-folding
 *   invariance law, whose rows are drawn from committed board cases and whose variants are the upper-,
 *   lower- and title-case renderings of those same queries.
 *
 *   Runs through the Gauntlet's own deps, so the pipeline under test is the one the board grades, not a
 *   second assembly of it. Rows are audited before the engine loads; `status: pass` rows gate the exit
 *   code, tracked rows report without blocking, and a tracked row that starts holding prints a promotion
 *   instruction.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Conformance-law suites (case-folding invariance) through the Gauntlet's deps"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "conformance",
	description,
	options: {
		suite: { type: "string", description: "Alternate law suite JSONL (default: the case-folding suite)" },
		candidate: { type: "string", description: "Candidate ONNX" },
		tokenizer: { type: "string", description: "Candidate tokenizer" },
		card: { type: "string", description: "Candidate model card" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		"candidate-db": { type: "string", description: "Candidate gazetteer artifact" },
	},
} as const satisfies CommandSpec

interface Options {
	suite?: string
	candidate?: string
	tokenizer?: string
	card?: string
	weightsCache?: string
	candidateDB?: string
}

const EvalConformance: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runConformanceCommand } = await import("../../eval-harness/conformance/command.ts")

			return runConformanceCommand({
				...(options.suite ? { suite: options.suite } : {}),
				...(options.candidate ? { modelPath: options.candidate } : {}),
				...(options.tokenizer ? { tokenizerPath: options.tokenizer } : {}),
				...(options.card ? { modelCardPath: options.card } : {}),
				...(options.weightsCache ? { weightsCacheRoot: options.weightsCache } : {}),
				...(options.candidateDB ? { candidateDB: options.candidateDB } : {}),
			})
		},
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The runner narrates its own report + verdict lines — rendering anything here would duplicate it.
	return null
}

export default EvalConformance
