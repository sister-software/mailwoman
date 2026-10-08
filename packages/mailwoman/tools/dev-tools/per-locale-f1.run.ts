/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Command-line adapter for `mailwoman/eval-harness/per-locale-f1.ts`.
 */

import { caseNormalizationOf, DEFAULT_CASE_NORMALIZATION } from "@mailwoman/core/pipeline"
import { runIfScript } from "@mailwoman/core/scripting"
import { extractDelimited, parseArguments } from "@mailwoman/core/scripting/arguments"
import { parseAddressSystemConventions } from "@mailwoman/neural/classifier/options"

import { perLocaleF1 } from "#tools/eval-harness/per/locale-f1"

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
			"case-normalization": { type: "string", default: DEFAULT_CASE_NORMALIZATION },
			"suppress-gaz-near-postcode": { type: "boolean" },
			tokenizer: { type: "string" },
			"weights-cache": { type: "string" },
		},
		allowPositionals: true,
	})

	// The old parseArgs() only assigned a field when the flag was present (`!= null`),
	// leaving the module's own default in place otherwise.
	// Boolean flags were set to `true` on presence regardless of value.
	// A conditional spread here reproduces both behaviors exactly: an absent flag must
	// not arrive as `undefined` where that would override a default.
	await perLocaleF1({
		...(values["golden-dir"] ? { goldenDir: values["golden-dir"] } : {}),
		...(values.files ? { files: extractDelimited(values.files) } : {}),
		...(values["weights-cache"] ? { weightsCache: values["weights-cache"] } : {}),
		...(values.model ? { modelPath: values.model } : {}),
		...(values.tokenizer ? { tokenizerPath: values.tokenizer } : {}),
		...(values["model-card"] ? { modelCardPath: values["model-card"] } : {}),
		...(values["model-anchor-lookup"] ? { modelAnchorLookupPath: values["model-anchor-lookup"] } : {}),
		...(values["gazetteer-lexicon"] ? { gazetteerLexiconPath: values["gazetteer-lexicon"] } : {}),
		...(values["no-anchor"] !== undefined ? { noAnchor: true } : {}),
		...(values["suppress-gaz-near-postcode"] !== undefined ? { suppressGazNearPostcode: true } : {}),
		...(values.conventions ? { conventions: parseAddressSystemConventions(values.conventions) } : {}),
		...(values["bridge-gaps"] !== undefined ? { bridgeGaps: true } : {}),
		caseNormalization: caseNormalizationOf(values["case-normalization"]),
		...(values["out-json"] ? { outJSON: values["out-json"] } : {}),
	})
}

runIfScript(import.meta, main)
