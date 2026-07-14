/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval gate` — the promotion gate (#479): runs the standard eval battery against a
 *   candidate model, checks every number against a gate-spec contract
 *   (`mailwoman/eval-harness/gates/*.json`), and emits `<out-dir>/verdict.json`. Exit 0 = every
 *   floor met AND the mask-regression lock held; exit 1 = any miss; exit 2 = usage / lore-guard
 *   refusal. On PASS it prints the pre-filled `eval ledger-append` command (#885). The module
 *   narrates everything (provenance, battery legs, verdict lines) — this wrapper only owns argv +
 *   the exit code.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runPromotionGate } from "../../eval-harness/promotion-gate.ts"

export const description = "Promotion gate (#479) — eval battery + gate-spec floors → verdict.json"

const OptionsSchema = zod.object({
	model: zod.string().optional().describe("Candidate fp32 ONNX (required)"),
	int8: zod.string().optional().describe("Quantized int8 sibling — adds the int8 battery + delta cap"),
	gate: zod
		.string()
		.optional()
		.describe("Gate-spec JSON: a path, or a spec name resolved against eval-harness/gates/ (required)"),
	tokenizer: zod.string().optional().describe("Tokenizer path (default: the v0.6.0-a0 tokenizer under the data root)"),
	card: zod.string().optional().describe("Model-card JSON (default neural-weights-en-us/model-card.json)"),
	gazetteerLexicon: zod
		.string()
		.optional()
		.describe("Gazetteer lexicon JSON (default data/gazetteer/anchor-lexicon-v1.json)"),
	weightsCache: zod
		.string()
		.optional()
		.describe(
			"Package-shaped candidate weights dir (<root>/node_modules/@mailwoman/neural-weights-en-us) — #718-safe, feeds anchor+gazetteer+country via loadFromWeights; the only correct grade for a country-channel model (v6.2.0+). Alternative to --model."
		),
	outDir: zod.string().optional().describe("Battery output dir (default /tmp/gate-<label>-<hhmm>)"),
})

export { OptionsSchema as options }

const EvalGate: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		() => runPromotionGate(options),
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The gate narrates its own verdict lines — rendering anything here would pollute the captured report.
	return null
}

export default EvalGate
