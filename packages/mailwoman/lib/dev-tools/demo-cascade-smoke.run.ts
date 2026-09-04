/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   NOTE(de-shell): forwarding shim. The demo-cascade smoke eval (#524) now lives at
 *   `mailwoman/eval-harness/demo-cascade-smoke.ts` and `promotion-eval.ts` calls it IN-PROCESS. This
 *   shim keeps standalone invocation working unchanged. Output is byte-identical because the module
 *   owns every printed line.
 *
 *   Exit-code parity: 0 = the run completed (row failures are in the table + sidecar), 2 = missing
 *   artifacts / malformed rows. Do not add logic here.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { demoCascadeSmoke } from "#eval-harness/demo-cascade-smoke"

async function main(): Promise<void> {
	// Loose scan parity with the retired scripts/lib/cli-args helpers: unknown flags tolerated.
	const { values: rawValues } = parseArguments({
		options: {
			card: { type: "string" },
			db: { type: "string" },
			file: { type: "string" },
			fst: { type: "string" },
			"gazetteer-lexicon": { type: "string" },
			json: { type: "string" },
			model: { type: "string" },
			"stage-dir": { type: "string" },
			tokenizer: { type: "string" },
			explain: { type: "boolean" },
		},
		strict: false,
		allowPositionals: true,
	})

	// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
	const values = rawValues as Record<string, string | boolean | undefined>

	const result = await demoCascadeSmoke({
		card: values["card"] as string | undefined,
		db: values["db"] as string | undefined,
		file: values["file"] as string | undefined,
		fst: values["fst"] as string | undefined,
		gazetteerLexicon: values["gazetteer-lexicon"] as string | undefined,
		json: values["json"] as string | undefined,
		model: values["model"] as string | undefined,
		stageDir: values["stage-dir"] as string | undefined,
		tokenizer: values["tokenizer"] as string | undefined,
		explain: values["explain"] as boolean | undefined,
	})

	if (result.exitCode !== 0) {
		process.exitCode = result.exitCode
	}
}

runIfScript(import.meta, main)
