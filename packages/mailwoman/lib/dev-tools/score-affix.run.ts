/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Command-line adapter for `mailwoman/eval-harness/score-affix.ts`.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { scoreAffix } from "#eval-harness/score-affix"

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

	await scoreAffix({
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
