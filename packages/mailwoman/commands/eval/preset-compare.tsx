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

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Compare the 6 demo presets between the shipped baseline and a candidate"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "preset-compare",
	description,
	options: {
		"model-path": { type: "string", description: "Candidate ONNX (omit to print the baseline only)" },
		"tokenizer-path": { type: "string", description: "Candidate tokenizer (paired with --model-path)" },
	},
} as const satisfies CommandSpec

interface Options {
	modelPath?: string
	tokenizerPath?: string
}

const EvalPresetCompare: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { presetCompare } = await import("../../eval-harness/preset-compare.ts")

		return presetCompare(options)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// presetCompare prints each parse on stdout.
	return null
}

export default EvalPresetCompare
