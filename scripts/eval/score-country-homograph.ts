/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NOTE(de-shell): forwarding shim. The country-homograph scorer now lives at
 *   `mailwoman/eval-harness/score-country-homograph.ts` and `promotion-eval.ts` calls it IN-PROCESS.
 *   This shim keeps standalone invocation — `node scripts/eval/score-country-homograph.ts --model
 *   <onnx> [--file <jsonl>]` — working unchanged. Output is byte-identical because the module owns
 *   every printed line. Do not add logic here.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { scoreCountryHomograph } from "mailwoman/eval-harness/score-country-homograph"

async function main(): Promise<void> {
	// Loose scan parity with the retired scripts/lib/cli-args helpers: unknown flags tolerated.
	const { values: rawValues } = parseArguments({
		options: {
			conventions: { type: "string" },
			file: { type: "string" },
			"gazetteer-lexicon": { type: "string" },
			json: { type: "string" },
			model: { type: "string" },
			"bridge-gaps": { type: "boolean" },
			"suppress-gaz-near-postcode": { type: "boolean" },
			"weights-cache": { type: "string" },
		},
		strict: false,
		allowPositionals: true,
	})

	// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
	const values = rawValues as Record<string, string | boolean | undefined>

	await scoreCountryHomograph({
		conventions: values["conventions"] as string | undefined,
		file: values["file"] as string | undefined,
		gazetteerLexicon: values["gazetteer-lexicon"] as string | undefined,
		json: values["json"] as string | undefined,
		model: values["model"] as string | undefined,
		bridgeGaps: values["bridge-gaps"] as boolean | undefined,
		suppressGazNearPostcode: values["suppress-gaz-near-postcode"] as boolean | undefined,
		weightsCache: values["weights-cache"] as string | undefined,
	})
}

runIfScript(import.meta, main)
