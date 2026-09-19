/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval error-analysis` — categorized failure report over the golden eval set (the
 *   pre-publish 2pp promote eval. night-shift skill). Builds the classifier via `createScorer` in
 *   strict ship-config mode so a `--model` candidate is graded in-distribution (#566/#685 trap);
 *   `--no-strict` warns-and-continues for legacy pre-anchor models.
 */

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Categorized golden-set failure report (the pre-publish 2pp promote check)"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "error-analysis",
	description,
	options: {
		golden: { type: "string", description: "Golden eval-set dir, e.g. data/eval/golden/v0.1.2 (required)" },
		model: { type: "string", description: "Candidate ONNX (requires --tokenizer + --model-card)" },
		tokenizer: { type: "string", description: "Candidate tokenizer" },
		"model-card": { type: "string", description: "Candidate model-card" },
		"postcode-repair": { type: "boolean", default: false, description: "Parse with postcode repair enabled" },
		"word-consistency": {
			type: "boolean",
			default: false,
			description: "Parse with the production word-consistency heal (ship default since 2026-07-15)",
		},
		strict: {
			type: "boolean",
			default: true,
			description: "Fail closed if a declared channel can't be fed (--no-strict for legacy models)",
		},
	},
} as const satisfies CommandSpec

// The analysis prints its own markdown report on stdout, so no `json`.
const EvalErrorAnalysis = harnessCommand(
	spec,
	async (options) => {
		const { evalErrorAnalysis } = await import("#eval-harness/error-analysis")

		return evalErrorAnalysis(options)
	},
	{ exitCode: (exitCode) => exitCode }
)

export default EvalErrorAnalysis
