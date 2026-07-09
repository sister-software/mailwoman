/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval error-analysis` — categorized failure report over the golden eval set (the
 *   pre-publish 2pp promote gate; night-shift skill). Builds the classifier via `createScorer` in
 *   STRICT ship-config mode so a `--model` candidate is graded in-distribution (#566/#685 trap);
 *   `--no-strict` warns-and-continues for legacy pre-anchor models.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { evalErrorAnalysis } from "../../eval-harness/error-analysis.ts"

export const description = "Categorized golden-set failure report (the pre-publish 2pp promote gate)"

const OptionsSchema = zod.object({
	golden: zod.string().optional().describe("Golden eval-set dir, e.g. data/eval/golden/v0.1.2 (required)"),
	model: zod.string().optional().describe("Candidate ONNX (requires --tokenizer + --model-card)"),
	tokenizer: zod.string().optional().describe("Candidate tokenizer"),
	modelCard: zod.string().optional().describe("Candidate model-card"),
	postcodeRepair: zod.boolean().default(false).describe("Parse with postcode repair enabled"),
	strict: zod
		.boolean()
		.default(true)
		.describe("Fail closed if a declared channel can't be fed (--no-strict for legacy models)"),
})

export { OptionsSchema as options }

const EvalErrorAnalysis: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		() => evalErrorAnalysis(options),
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The analysis prints its own markdown report on stdout.
	return null
}

export default EvalErrorAnalysis
