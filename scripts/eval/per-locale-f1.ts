/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Command-line adapter for `mailwoman/eval-harness/per-locale-f1.ts`.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArgs } from "@mailwoman/platform/util"
import { perLocaleF1 } from "mailwoman/eval-harness/per-locale-f1"

async function main(): Promise<void> {
	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseArgs({
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
		strict: false,
		allowPositionals: true,
	})

	// The old parseArgs() only ASSIGNED a field when the flag was present (`!= null`), leaving the
	// module's own default in place otherwise — and the boolean flags were set to `true` on presence
	// regardless of value. Spreading conditionally here reproduces both behaviors exactly: an absent
	// flag must not arrive as `undefined` where that would override a default.
	await perLocaleF1({
		...(values["golden-dir"] != null ? { goldenDir: values["golden-dir"] as string } : {}),
		...(values["files"] != null
			? {
					files: (values["files"] as string)
						.split(",")
						.map((s) => s.trim())
						.filter((file) => file.length > 0),
				}
			: {}),
		...(values["weights-cache"] != null ? { weightsCache: values["weights-cache"] as string } : {}),
		...(values["model"] != null ? { modelPath: values["model"] as string } : {}),
		...(values["tokenizer"] != null ? { tokenizerPath: values["tokenizer"] as string } : {}),
		...(values["model-card"] != null ? { modelCardPath: values["model-card"] as string } : {}),
		...(values["model-anchor-lookup"] != null
			? { modelAnchorLookupPath: values["model-anchor-lookup"] as string }
			: {}),
		...(values["gazetteer-lexicon"] != null ? { gazetteerLexiconPath: values["gazetteer-lexicon"] as string } : {}),
		...(values["no-anchor"] != null ? { noAnchor: true } : {}),
		...(values["suppress-gaz-near-postcode"] != null ? { suppressGazNearPostcode: true } : {}),
		...(values["conventions"] != null ? { conventions: values["conventions"] as string } : {}),
		...(values["bridge-gaps"] != null ? { bridgeGaps: true } : {}),
		...(values["raw-case"] != null ? { rawCase: true } : {}),
		...(values["out-json"] != null ? { outJSON: values["out-json"] as string } : {}),
	})
}

runIfScript(import.meta, main)
