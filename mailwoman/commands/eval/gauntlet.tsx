/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval gauntlet` — THE Gauntlet gate: all three layers, one combined verdict (the
 *   full-pipeline integration net a model ship gates on; #566 lesson). No flags = self-check on the
 *   shipped default (regression + metamorphic); `--candidate` adds the held-out candidate-vs-prod
 *   z-test; `--layer` runs a single layer with the old standalone semantics (its own verdict + exit
 *   code). A non-zero exit blocks the ship (RELEASING.md).
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runGauntlet } from "../../eval-harness/gauntlet/run.ts"

export const description = "The Gauntlet gate — regression + metamorphic + held-out, one verdict"

const OptionsSchema = zod.object({
	candidate: zod.string().optional().describe("Candidate ONNX (omit for the shipped-default self-check)"),
	source: zod.string().default("fr").describe("held-out: truth source (fr = BAN, us = FDIC)"),
	tokenizer: zod.string().optional().describe("Tokenizer-splice candidate: the candidate tokenizer"),
	card: zod.string().optional().describe("Tokenizer-splice candidate: the candidate model-card"),
	layer: zod
		.enum(["regression", "metamorphic", "holdout"])
		.optional()
		.describe("Run ONE layer instead of the combined gate"),
	n: zod.number().default(300).describe("held-out: fresh-draw sample size"),
})

export { OptionsSchema as options }

const EvalGauntlet: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () => (await runGauntlet(options)).exitCode,
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The layers narrate their own verdict lines on stdout.
	return null
}

export default EvalGauntlet
