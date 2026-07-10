/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval mask-regression` — the per-release mask-regression gate (#718), the "second
 *   lock" beside `createScorer`'s load-time capability delta-gate: re-runs the ship artifact
 *   mask-off vs mask-on and FAILS (exit 1) if ANY tag's unfolded F1 drops more than the threshold
 *   (default 2pp) under the conventions mask. Weight-dependent — a release gate, never a CI step
 *   (#582). `eval gate` runs it automatically when the spec declares `requires_conventions`.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { maskRegressionGate } from "../../eval-harness/mask-regression.ts"

export const description = "Mask-regression gate (#718) — mask-off vs mask-on per-tag F1, 2pp lock"

const OptionsSchema = zod.object({
	model: zod.string().optional().describe("ONNX artifact (default: the production int8 under the data root)"),
	tokenizer: zod.string().optional().describe("Tokenizer (default: the v0.6.0-a0 tokenizer under the data root)"),
	modelCard: zod.string().optional().describe("Model card JSON (default neural-weights-en-us/model-card.json)"),
	anchorLookup: zod.string().optional().describe("Anchor lookup JSON (default: the pilot lookup under the data root)"),
	gazetteerLexicon: zod
		.string()
		.optional()
		.describe("Gazetteer lexicon JSON (default data/gazetteer/anchor-lexicon-v1.json)"),
	threshold: zod.number().optional().describe("Regression threshold as a fraction (default 0.02 = 2pp)"),
	json: zod.string().optional().describe("Write the full per-tag delta table here"),
})

export { OptionsSchema as options }

const EvalMaskRegression: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () => (await maskRegressionGate(options)).pass,
		(pass) => (pass ? 0 : 1)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The gate narrates its own ✓ PASS / ✗ FAIL lines on stderr.
	return null
}

export default EvalMaskRegression
