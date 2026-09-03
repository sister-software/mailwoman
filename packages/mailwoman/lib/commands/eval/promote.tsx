/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval promote` — `promotion-eval.ts` (#479): runs the standard eval battery against a
 *   candidate model, checks every number against an eval spec contract
 *   (`mailwoman/eval-harness/specs/*.json`), and emits `<out-dir>/verdict.json`. Exit 0 = every
 *   floor met AND the mask-regression lock held; exit 1 = any miss; exit 2 = usage / lore-guard
 *   refusal. On PASS it prints the pre-filled `eval ledger-append` command (#885). The module
 *   narrates everything (provenance, battery legs, verdict lines) — this wrapper only owns argv +
 *   the exit code.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Promotion check (#479) — eval battery + check-spec floors → verdict.json"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "check",
	description,
	options: {
		model: { type: "string", description: "Candidate fp32 ONNX (required)" },
		int8: { type: "string", description: "Quantized int8 sibling — adds the int8 battery + delta cap" },
		check: { type: "string", description: "Check-spec JSON path or registered name (required)" },
		tokenizer: { type: "string", description: "Tokenizer path" },
		card: { type: "string", description: "Model-card JSON" },
		"gazetteer-lexicon": { type: "string", description: "Gazetteer lexicon JSON" },
		"weights-cache": { type: "string", description: "Package-shaped candidate weights directory" },
		"int8-weights-cache": { type: "string", description: "Package-shaped INT8 candidate directory" },
		"out-dir": { type: "string", description: "Battery output dir (default /tmp/eval-<label>-<hhmm>)" },
	},
} as const satisfies CommandSpec

interface Options {
	model?: string
	int8?: string
	check?: string
	tokenizer?: string
	card?: string
	gazetteerLexicon?: string
	weightsCache?: string
	int8WeightsCache?: string
	outDir?: string
}

const EvalPromote: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runPromotionEval } = await import("#eval-harness/promotion-eval")

			return await runPromotionEval(options)
		},
		(exitCode) => exitCode
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	// `promotion-eval.ts` narrates its own verdict lines — rendering anything here would pollute the captured report.
	return null
}

export default EvalPromote
