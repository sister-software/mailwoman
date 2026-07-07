/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   PIP-containment 2×2 for German (#327/#386, the honest-metric companion to de-order-eval.ts). The
 *   name-match DE metric is misleading: it fails when WOF's canonical name drops OA's regional suffix
 *   ("Plauen Vogtl" -> "Plauen") even though the resolve is geographically correct. This harness re-scores
 *   the SAME native/international × anchor-on/off cells by PIP-containment (gold OA point inside the resolved
 *   WOF polygon — non-gameable), via oa-resolver-eval --out-resolved + pip-containment.py. The v0.9.4 finding:
 *   intl name 43.7% but PIP 56.1%; Saxony name 51.1% but PIP 75.9% (+24.8pp artifact). Use this, not name-match.
 *
 *   Usage:
 *     node scripts/eval/de-pip-eval.ts --model /tmp/v094-eval/model.onnx --card neural-weights-en-us/model-card.json \
 *       [--tokenizer ...] [--anchor-lookup ...] [--out /tmp/de-pip]
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { runIfScript } from "mailwoman/sdk/scripting"
import { $ } from "zx"

runIfScript(import.meta, async () => {
	let MODEL = ""
	let CARD = ""
	let TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	let LOOKUP = dataRootPath("anchor", "pilot-anchor-lookup.json")
	let OUT = "/tmp/de-pip"

	// STRICT parseArgs — the original switch errored on unknown args; parity preserved.
	let cliValues: Record<string, string | boolean | undefined>

	try {
		cliValues = parseArgs({
			options: {
				"anchor-lookup": { type: "string" },
				card: { type: "string" },
				model: { type: "string" },
				out: { type: "string" },
				tokenizer: { type: "string" },
			},
		}).values
	} catch (e) {
		throw new Error(`unknown arg: ${e instanceof Error ? e.message : e}`)
	}

	if (cliValues["model"] != null) MODEL = cliValues["model"] as string
	if (cliValues["card"] != null) CARD = cliValues["card"] as string
	if (cliValues["tokenizer"] != null) TOK = cliValues["tokenizer"] as string
	if (cliValues["anchor-lookup"] != null) LOOKUP = cliValues["anchor-lookup"] as string
	if (cliValues["out"] != null) OUT = cliValues["out"] as string

	if (!MODEL || !CARD) throw new Error("need --model and --card")

	$.verbose = false

	mkdirSync(OUT, { recursive: true })
	const EMPTY = `${OUT}/empty-anchor.json`
	writeFileSync(EMPTY, "{}\n")
	const DE_NATIVE = "data/eval/external/openaddresses-de-sample-native-order.jsonl"
	const DE_INTL = "data/eval/external/openaddresses-de-sample.jsonl"

	// dump <eval-jsonl> <anchor-lookup> <out-name>
	const dump = async (evalPath: string, lookup: string, name: string): Promise<void> => {
		const r =
			await $`node --experimental-strip-types scripts/eval/oa-resolver-eval.ts --eval ${evalPath} --model ${MODEL} --model-card ${CARD} --tokenizer ${TOK} --model-anchor-lookup ${lookup} --default-country DE --out-resolved ${`${OUT}/${name}.json`}`
		writeFileSync(`${OUT}/${name}.eval.md`, r.stdout)
		writeFileSync(`${OUT}/${name}.log`, r.stderr)
	}
	// pip <out-name> -> the OVERALL PIP line. The bash ran this inside `$(...)` with `2>/dev/null | grep
	// OVERALL`, so a python error or a no-match is tolerated (empty) rather than aborting -> nothrow.
	const pip = async (name: string): Promise<string> => {
		const r = await $({ nothrow: true })`python3 scripts/eval/pip-containment.py ${`${OUT}/${name}.json`}`

		return r.stdout
			.split("\n")
			.filter((l) => l.includes("OVERALL"))
			.join("\n")
	}

	console.log("== dumping resolved (native on/off, intl on/off) ==")
	await dump(DE_NATIVE, LOOKUP, "native-on")
	await dump(DE_NATIVE, EMPTY, "native-off")
	await dump(DE_INTL, LOOKUP, "intl-on")
	await dump(DE_INTL, EMPTY, "intl-off")

	console.log("")
	console.log(`### DE PIP-containment 2×2 (model: ${MODEL})`)
	console.log(`native anchor-ON : ${await pip("native-on")}`)
	console.log(`native anchor-OFF: ${await pip("native-off")}`)
	console.log(`intl   anchor-ON : ${await pip("intl-on")}`)
	console.log(`intl   anchor-OFF: ${await pip("intl-off")}`)
	console.log("")
	console.log(`(per-state name-vs-PIP breakdown: python3 scripts/eval/pip-containment.py ${OUT}/intl-on.json)`)
})
