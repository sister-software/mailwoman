/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One-command checkpoint read for the #511 v1.1.0 relabel run: export the given step on Modal,
 *   download, and score BOTH affix evals (32-row legacy + NAD-native v2) with ship-config channels.
 *   The 20k read gates stability (pre-registered floors on #511: v2 prefix/suffix F1 >= 85, P >=
 *   95); the 40k read feeds the full v4.2.0-ship gate battery (promotion-gate.ts) on top.
 *
 *   Usage: node scripts/eval/read-relabel-checkpoint.ts 020000 (zero-padded step)
 */

import { basename } from "node:path"
import { parseArgs } from "node:util"

import { runIfScript } from "mailwoman/sdk/scripting"
import { $ } from "zx"

const { positionals } = parseArgs({ allowPositionals: true, strict: false })
runIfScript(import.meta, async () => {
	const step = positionals[0]

	if (!step) throw new Error("usage: read-relabel-checkpoint.ts <zero-padded-step, e.g. 020000>")

	const outDir = "/data/output-v110-relabel-s42"
	const local = `/tmp/v110-relabel-${step}.onnx`

	// zx: capture output ourselves (don't echo the full stream) and slice the way the bash `| tail` did.
	$.verbose = false

	console.error(`== export step-${step} on Modal ==`)
	const exported = await $({
		nothrow: true,
	})`modal run corpus-python/modal/train_remote.py::export_onnx --output-dir=${outDir} --step=${step}`
	console.error(`${exported.stdout}${exported.stderr}`.trim().split("\n").slice(-2).join("\n"))
	const got = await $({
		nothrow: true,
	})`modal volume get mailwoman-training ${`${outDir.replace(/^\/data\//, "")}/model.onnx`} ${local} --force`
	console.error(`${got.stdout}${got.stderr}`.trim().split("\n").slice(-1).join("\n"))

	for (const evalFile of [
		"data/eval/external/street-affix-real.jsonl",
		"data/eval/external/street-affix-real-v2.jsonl",
	]) {
		console.error(`\n== score-affix · ${basename(evalFile)} ==`)
		const scored = await $({
			nothrow: true,
		})`node --experimental-strip-types scripts/eval/score-affix.ts --model ${local} --file ${evalFile} --gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json --suppress-gaz-near-postcode`
		console.error(scored.stdout.split("\n").slice(0, 9).join("\n"))
	}

	console.error(`\nmodel: ${local} (keep for the fp32-to-fp32 gate at 40k)`)
})
