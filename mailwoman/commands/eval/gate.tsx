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
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

export const description = "Promotion gate (#479) — eval battery + gate-spec floors → verdict.json"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "gate",
	description,
	options: {
		model: { type: "string", description: "Candidate fp32 ONNX (required)" },
		int8: { type: "string", description: "Quantized int8 sibling — adds the int8 battery + delta cap" },
		gate: { type: "string", description: "Gate-spec JSON path or registered name (required)" },
		tokenizer: { type: "string", description: "Tokenizer path" },
		card: { type: "string", description: "Model-card JSON" },
		"gazetteer-lexicon": { type: "string", description: "Gazetteer lexicon JSON" },
		"weights-cache": { type: "string", description: "Package-shaped candidate weights directory" },
		"int8-weights-cache": { type: "string", description: "Package-shaped INT8 candidate directory" },
		"out-dir": { type: "string", description: "Battery output dir (default /tmp/gate-<label>-<hhmm>)" },
	},
} as const satisfies CommandSpec

interface Options {
	model?: string
	int8?: string
	gate?: string
	tokenizer?: string
	card?: string
	gazetteerLexicon?: string
	weightsCache?: string
	int8WeightsCache?: string
	outDir?: string
}

const EvalGate: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runPromotionGate } = await import("../../eval-harness/promotion-gate.ts")

			return runPromotionGate(options)
		},
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The gate narrates its own verdict lines — rendering anything here would pollute the captured report.
	return null
}

export default EvalGate
