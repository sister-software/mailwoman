/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NOTE(de-shell): forwarding shim. The FR bare-street parse-recall leg now lives at
 *   `mailwoman/eval-harness/fr-parse-recall.ts` and `promotion-gate.ts` calls it IN-PROCESS.
 *
 *   It USED to live at `scripts/diagnostic/fr-parse-recall.ts`, which was the wrong drawer for it:
 *   `scripts/diagnostic/` is `.gitignore`d wholesale, so a eval-required leg was surviving only
 *   because someone had force-added it to the index. This shim therefore sits in `scripts/eval/` —
 *   the referenced-probe drawer — so `node scripts/eval/fr-parse-recall.ts` keeps working, and the
 *   old diagnostic path is gone.
 *
 *   Exit code parity: the module returns the floor verdict, and this shim maps a miss back to exit
 *   1, which is what `--floor` promised. Do not add logic here.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { frParseRecall } from "mailwoman/eval-harness/fr-parse-recall"

async function main(): Promise<void> {
	const { values: args } = parseArguments({
		options: {
			model: { type: "string" },
			tokenizer: { type: "string" },
			"model-card": { type: "string", default: "packages/neural-weights-en-us/model-card.json" },
			label: { type: "string", default: "" },
			fixture: { type: "string", default: "scripts/eval/fixtures/fr-bare-street-40.jsonl" },
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
