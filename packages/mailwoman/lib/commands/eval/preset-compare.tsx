/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval preset-compare` — the 6 demo presets through the shipped baseline (and
 *   optionally a candidate model), one parse per line. The eval-model skill's quick demo-smoke
 *   companion; `eval promote` captures the same report into `<out-dir>/presets.md`.
 */

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Compare the 6 demo presets between the shipped baseline and a candidate"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "preset-compare",
	description,
	options: {
		"model-path": { type: "string", description: "Candidate ONNX (omit to print the baseline only)" },
		"tokenizer-path": { type: "string", description: "Candidate tokenizer (paired with --model-path)" },
	},
} as const satisfies CommandSpec

// `presetCompare` prints each parse on stdout, so no `json`.
const EvalPresetCompare = harnessCommand(spec, async (options) => {
	const { presetCompare } = await import("#eval-harness/preset-compare")

	return presetCompare(options)
})

export default EvalPresetCompare
