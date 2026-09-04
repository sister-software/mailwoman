/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Standalone entry for the FR bare-street parse-recall leg. The measurement lives in
 *   `#eval-harness/fr-parse-recall` and `promotion-eval.ts` calls it IN-PROCESS; this file exists so
 *   the leg can be run on its own — the `fr.bare_street_intact` floor's provenance in the promotion
 *   specs (`v2.3.0-nl-postcode.json`, `v5.3.0-family.json`) names it.
 *
 *   Exit code parity: the module returns the floor verdict, and this entry maps a miss back to exit
 *   1, which is what `--floor` promised. Do not add logic here.
 *
 *   Run: node packages/mailwoman/lib/dev-tools/fr-parse-recall.run.ts [--floor 75]
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { frParseRecall } from "#eval-harness/fr-parse-recall"

async function main(): Promise<void> {
	const { values: args } = parseArguments({
		options: {
			model: { type: "string" },
			tokenizer: { type: "string" },
			"model-card": { type: "string", default: "packages/neural-weights-en-us/model-card.json" },
			label: { type: "string", default: "" },
			fixture: { type: "string", default: "packages/mailwoman/lib/eval-harness/fixtures/fr-bare-street-40.jsonl" },
			"from-db": { type: "boolean", default: false },
			json: { type: "string" },
			floor: { type: "string" },
		},
	})

	const result = await frParseRecall({
		model: args.model,
		tokenizer: args.tokenizer,
		modelCard: args["model-card"],
		label: args.label,
		fixture: args.fixture,
		fromDB: args["from-db"],
		json: args.json,
		floor: args.floor,
	})

	if (!result.pass) {
		process.exitCode = 1
	}
}

runIfScript(import.meta, main)
