/**
 * German coverage eval (DE-4/DE-5) — measures whether a model learned German order, and whether US/FR regressed (the
 * interference tripwire). Run against the v0.7.2 baseline AND the v0.8.0-german model for a before/after. Usage: node
 * scripts/eval-de-coverage.ts <model.onnx> <tokenizer.model> <model-card.json> Defaults to the v0.7.2 artifacts in
 * /tmp/v072-eval.
 */

import { dataRootPath } from "@mailwoman/core/utils"
import { runIfScript } from "mailwoman/sdk/scripting"
import { $ } from "zx"

/**
 * Mirror `grep -A<after> <needle>` for the single-match case: the match line + `after` lines below it.
 */
function printGrepAfter(stdout: string, needle: string, after: number): void {
	const lines = stdout.split("\n")
	const idx = lines.findIndex((l) => l.includes(needle))

	if (idx >= 0) console.log(lines.slice(idx, idx + after + 1).join("\n"))
}

runIfScript(import.meta, async () => {
	const MODEL = process.argv[2] ?? "/tmp/v072-eval/model.onnx"
	const TOK = process.argv[3] ?? dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	const CARD = process.argv[4] ?? "/tmp/v072-eval/model-card.json"
	const WOF = dataRootPath("wof", "admin-global-priority.db")

	$.verbose = false

	console.log(`##### Model: ${MODEL}`)
	console.log("")
	console.log("===== DE-4a: German parser F1 (held-out OA German golden) =====")
	const r1 =
		await $`node --experimental-strip-types scripts/eval/per-locale-f1.ts --golden-dir data/eval/external --files openaddresses-de-golden.jsonl --model ${MODEL} --tokenizer ${TOK} --model-card ${CARD}`
	printGrepAfter(r1.stdout, "Per-tag F1", 12)

	console.log("")
	console.log("===== DE-4b: US/FR interference tripwire (must stay within ~1pp of baseline) =====")
	const r2 =
		await $`node --experimental-strip-types scripts/eval/per-locale-f1.ts --golden-dir data/eval/golden/v0.1.2/dev --files us.jsonl,fr.jsonl --model ${MODEL} --tokenizer ${TOK} --model-card ${CARD}`
	console.log(
		r2.stdout
			.split("\n")
			.filter((l) => /^\| (us|fr) /.test(l))
			.join("\n")
	)

	console.log("")
	console.log("===== DE-5: German resolver eval (--default-country DE) =====")
	const r3 =
		await $`node --experimental-strip-types scripts/eval/oa-resolver-eval.ts --eval data/eval/external/openaddresses-de-sample.jsonl --limit 3000 --default-country DE --model ${MODEL} --tokenizer ${TOK} --model-card ${CARD} --wof ${WOF}`
	printGrepAfter(r3.stdout, "Head-to-head", 6)
})
