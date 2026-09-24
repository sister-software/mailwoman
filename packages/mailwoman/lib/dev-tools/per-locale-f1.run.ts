/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Command-line adapter for `mailwoman/eval-harness/per-locale-f1.ts`.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { extractDelimited, parseArguments } from "@mailwoman/core/scripting/arguments"

import { perLocaleF1 } from "#eval-harness/per/locale-f1"

async function main(): Promise<void> {
	const { values } = parseArguments({
		options: {
			"bridge-gaps": { type: "boolean" },
			conventions: { type: "string" },
			files: { type: "string" },
			"gazetteer-lexicon": { type: "string" },
			"golden-dir": { type: "string" },
			model: { type: "string" },
			"model-anchor-lookup": { type: "string" },
			"model-card": { type: "string" },
			"no-anchor": { type: "boolean" },
			"out-json": { type: "string" },
			"raw-case": { type: "boolean" },
			"suppress-gaz-near-postcode": { type: "boolean" },
			tokenizer: { type: "string" },
			"weights-cache": { type: "string" },
		},
		allowPositionals: true,
	})

	// The old parseArgs() only assigned a field when the flag was present (`!= null`),
	// leaving the module's own default in place otherwise, and the boolean flags
	// were set to `true` on presence regardless of value.
	// Spreading conditionally here reproduces both behaviors exactly: an absent flag
	// must not arrive as `undefined` where that would override a default.
	await perLocaleF1({
		...(values["golden-dir"] !== undefined ? { goldenDir: values["golden-dir"] } : {}),
		...(values.files !== undefined ? { files: extractDelimited(values.files) } : {}),
		...(values["weights-cache"] !== undefined ? { weightsCache: values["weights-cache"] } : {}),
		...(values.model !== undefined ? { modelPath: values.model } : {}),
		...(values.tokenizer !== undefined ? { tokenizerPath: values.tokenizer } : {}),
		...(values["model-card"] !== undefined ? { modelCardPath: values["model-card"] } : {}),
		...(values["model-anchor-lookup"] !== undefined ? { modelAnchorLookupPath: values["model-anchor-lookup"] } : {}),
		...(values["gazetteer-lexicon"] !== undefined ? { gazetteerLexiconPath: values["gazetteer-lexicon"] } : {}),
		...(values["no-anchor"] !== undefined ? { noAnchor: true } : {}),
		...(values["suppress-gaz-near-postcode"] !== undefined ? { suppressGazNearPostcode: true } : {}),
		...(values.conventions !== undefined ? { conventions: values.conventions } : {}),
		...(values["bridge-gaps"] !== undefined ? { bridgeGaps: true } : {}),
		...(values["raw-case"] !== undefined ? { rawCase: true } : {}),
		...(values["out-json"] !== undefined ? { outJSON: values["out-json"] } : {}),
	})
}

runIfScript(import.meta, main)
