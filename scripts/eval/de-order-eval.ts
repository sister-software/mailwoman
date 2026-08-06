/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NOTE(de-shell): forwarding shim. The both-order order-robustness harness now lives at
 *   `mailwoman/eval-harness/de-order-eval.ts` and the promotion gate calls it IN-PROCESS. This shim
 *   keeps standalone invocation working unchanged. Output is byte-identical because the module owns
 *   every printed line. Do not add logic here.
 */

import { parseArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"

import { deOrderEval } from "../../mailwoman/eval-harness/de-order-eval.ts"

async function main(): Promise<void> {
	// STRICT parseArgs — the original switch errored on unknown args; parity preserved.
	let values: Record<string, string | boolean | undefined>

	try {
		values = parseArgs({
			options: {
				"anchor-lookup": { type: "string" },
				card: { type: "string" },
				model: { type: "string" },
				out: { type: "string" },
				tokenizer: { type: "string" },
			},
		}).values
	} catch (error) {
		console.error(`unknown arg: ${error instanceof Error ? error.message : error}`)

		process.exitCode = 1

		return
	}

	const result = await deOrderEval({
		model: values["model"] as string | undefined,
		card: values["card"] as string | undefined,
		tokenizer: values["tokenizer"] as string | undefined,
		anchorLookup: values["anchor-lookup"] as string | undefined,
		out: values["out"] as string | undefined,
	})

	// Parity with the old `need --model and --card` → exit 1.
	if (!result.ok) {
		process.exitCode = 1
	}
}

runIfScript(import.meta, main)
