/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NOTE(de-shell): forwarding shim. The three unbiased capability arenas now live at
 *   `mailwoman/eval-harness/external-arenas.ts` and `promotion-eval.ts` calls them IN-PROCESS. This
 *   shim keeps standalone invocation working unchanged. Output is byte-identical because the module
 *   owns every printed line. Do not add logic here.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { externalArenas } from "#eval-harness/external-arenas"

async function main(): Promise<void> {
	// Flags replace the bash-era env contract (MODEL=… TOKENIZER=… → --model … --tokenizer …).
	const { values: cli } = parseArguments({
		options: {
			"out-dir": { type: "string" },
			model: { type: "string" },
			tokenizer: { type: "string" },
			"model-card": { type: "string" },
			"gazetteer-lexicon": { type: "string" },
			"anchor-lookup": { type: "string" },
			conventions: { type: "string" },
			"bridge-gaps": { type: "boolean" },
		},
	})

	await externalArenas({
		outDir: cli["out-dir"],
		model: cli.model,
		tokenizer: cli.tokenizer,
		modelCard: cli["model-card"],
		gazetteerLexicon: cli["gazetteer-lexicon"],
		anchorLookup: cli["anchor-lookup"],
		conventions: cli.conventions,
		bridgeGaps: cli["bridge-gaps"],
	})
}

runIfScript(import.meta, main)
