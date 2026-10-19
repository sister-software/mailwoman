/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Standalone entry for the DE both-order robustness leg. The measurement lives in
 *   `#tools/eval-harness/de/order-eval`, and the promotion check calls it in-process.
 *   This entry maps a failed run to exit 1. Keep logic in the module.
 *
 *   Run: node packages/mailwoman/tools/dev-tools/de/order-eval.run.ts --model <onnx> --card <model-card.json>
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { deOrderEval } from "#tools/eval-harness/de/order-eval"

async function main(): Promise<void> {
	const { values: args } = parseArguments({
		options: {
			model: { type: "string" },
			card: { type: "string" },
			tokenizer: { type: "string" },
			"anchor-lookup": { type: "string" },
			out: { type: "string" },
			limit: { type: "string" },
			"lookup-memo": { type: "boolean", default: false },
			"profile-dir": { type: "string" },
		},
	})

	const result = await deOrderEval({
		model: args.model,
		card: args.card,
		tokenizer: args.tokenizer,
		anchorLookup: args["anchor-lookup"],
		out: args.out,
		limit: args.limit ? Number(args.limit) : null,
		lookupMemo: args["lookup-memo"],
		profileDirectory: args["profile-dir"],
	})

	if (!result.ok) {
		process.exitCode = 1
	}
}

runIfScript(import.meta, main)
