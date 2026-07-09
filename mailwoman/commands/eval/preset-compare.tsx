/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval preset-compare` — the 6 demo presets through the shipped baseline (and
 *   optionally a candidate model), one parse per line. The eval-model skill's quick demo-smoke
 *   companion; `eval gate` captures the same report into `<out-dir>/presets.md`.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { presetCompare } from "../../eval-harness/preset-compare.ts"

export const description = "Compare the 6 demo presets between the shipped baseline and a candidate"

const OptionsSchema = zod.object({
	modelPath: zod.string().optional().describe("Candidate ONNX (omit to print the baseline only)"),
	tokenizerPath: zod.string().optional().describe("Candidate tokenizer (paired with --model-path)"),
})

export { OptionsSchema as options }

const EvalPresetCompare: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => presetCompare(options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// presetCompare prints each parse on stdout.
	return null
}

export default EvalPresetCompare
