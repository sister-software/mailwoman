/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval mask-regression` — the per-release mask-regression check (#718), the "second
 *   lock" beside `createScorer`'s load-time capability delta check: re-runs the ship artifact
 *   mask-off vs mask-on and fails (exit 1) if any tag's unfolded F1 drops more than the threshold
 *   (default 2pp) under the conventions mask. Weight-dependent — a release eval, never a CI step
 *   (#582). `eval promote` runs it automatically when the spec declares `requires_conventions`.
 */

import { type CommandSpec, harnessCommand } from "#cli-kit"

export const description = "Mask-regression check (#718) — mask-off vs mask-on per-tag F1, 2pp lock"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "mask-regression",
	description,
	options: {
		model: { type: "string", description: "ONNX artifact (default: the production int8 under the data root)" },
		tokenizer: { type: "string", description: "Tokenizer (default: the v0.6.0-a0 tokenizer under the data root)" },
		"model-card": { type: "string", description: "Model card JSON (default neural-weights-en-us/model-card.json)" },
		"anchor-lookup": {
			type: "string",
			description: "Anchor lookup JSON (default: the pilot lookup under the data root)",
		},
		"gazetteer-lexicon": {
			type: "string",
			description: "Gazetteer lexicon JSON (default data/gazetteer/anchor-lexicon-v1.json)",
		},
		threshold: { type: "number", description: "Regression threshold as a fraction (default 0.02 = 2pp)" },
		json: { type: "string", description: "Write the full per-tag delta table here" },
	},
} as const satisfies CommandSpec

// The check narrates its own ✓ pass / ✗ fail lines on stderr, so no `json`.
const EvalMaskRegression = harnessCommand(
	spec,
	async (options) => {
		const { maskRegressionCheck } = await import("#eval-harness/mask-regression")

		return (await maskRegressionCheck(options)).pass
	},
	{ exitCode: (pass) => (pass ? 0 : 1) }
)

export default EvalMaskRegression
