/**
 * V07-calibration-gate.ts — run the v0.7 #31 calibration gate eval.
 *
 * Given the calibration model's exported ONNX, runs the three gate measurements against the held-out TEST split and the
 * assertion harness, so the decision tree can be applied:
 *
 *     harness pass rate improves AND overconfidence drops  -> ship calibration
 *     flat                                                 -> pivot to structural
 *
 * V0.6.0 baselines (captured this shift, for comparison): - harness pass rate: 14.6% (no repair) / 15.2% (+repair) -
 * postcode-only harness: 75.9% / 80.2% (+repair) - per-tag recall on TEST: locality 36.9%, region 66.6%, street 30.1%,
 * postcode 74.8%, house_number 77.7%, venue 33.9% - structurally valid: 97.6% - overconfidence-on-wrong: 85.5% of wrong
 * predictions made at >=0.9 conf (1712/2003 on TEST; plan target after calib ~50%)
 *
 * Usage: node scripts/eval/v07-calibration-gate.ts <calib-model.onnx> [out-dir]
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { runIfScript } from "mailwoman/sdk/scripting"
import { $ } from "zx"

const { positionals } = parseArgs({ allowPositionals: true, strict: false })

async function main() {
	const CALIB = positionals[0]

	if (!CALIB) throw new Error("usage: v07-calibration-gate.ts <calib-model.onnx> [out-dir]")
	const OUT = positionals[1] ?? "/tmp/v07-gate"
	mkdirSync(OUT, { recursive: true })

	const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	const CARD = "neural-weights-en-us/model-card.json"

	// zx: capture output ourselves; the originals piped to grep/head/tail — we slice in JS instead.
	$.verbose = false

	console.log("### 1/4 — per-tag recall on held-out TEST (calibration)")
	const r1 =
		await $`node --experimental-strip-types scripts/eval-error-analysis.ts --golden data/eval/golden/v0.1.2/test --model ${CALIB} --tokenizer ${TOK} --model-card ${CARD}`
	writeFileSync(`${OUT}/calib-test-pertag.md`, r1.stdout)

	if (r1.stderr) {
		process.stderr.write(r1.stderr)
	}

	{
		// grep -A14 "Per-tag breakdown" | head -16  ->  the match line + 14 after (head -16 is a no-op on 15 lines)
		const lines = r1.stdout.split("\n")
		const idx = lines.findIndex((l) => l.includes("Per-tag breakdown"))

		if (idx >= 0) {
			console.log(lines.slice(idx, idx + 15).join("\n"))
		}
	}

	console.log("### 2/4 — harness pass rate (calibration, no repair)")
	const r2 =
		await $`node --experimental-strip-types scripts/harness-v0-neural.ts --tests mailwoman/test --model ${CALIB} --tokenizer ${TOK} --model-card ${CARD} --out-json ${`${OUT}/calib-harness.json`}`
	// grep -iE "^\| (Neural|v0 )"  (\| is a literal pipe in ERE)
	console.log(
		r2.stdout
			.split("\n")
			.filter((l) => /^\| (Neural|v0 )/i.test(l))
			.join("\n")
	)

	console.log("### 3/4 — harness pass rate (calibration + postcode repair)")
	const r3 =
		await $`node --experimental-strip-types scripts/harness-v0-neural.ts --tests mailwoman/test --model ${CALIB} --tokenizer ${TOK} --model-card ${CARD} --postcode-repair --out-json ${`${OUT}/calib-harness-repair.json`}`
	console.log(
		r3.stdout
			.split("\n")
			.filter((l) => /^\| (Neural|v0 )/i.test(l))
			.join("\n")
	)

	console.log("### 4/4 — overconfidence: v0.6.0 vs calibration (RETIRED)")
	// The overconfidence comparison ran via scripts/probe-confidence.ts — a CLOSED investigation
	// removed in the scripts cleanup (062c8ccc). Its successor scripts/eval/collect-span-confidences.ts
	// is a single-model per-span collector (one (conf, correct?) record → JSONL), not the two-model
	// (v0.6.0 vs calib) overconfidence comparison this step needs, so there's no drop-in. The v0.6.0
	// baseline (85.5% of wrong predictions made at >=0.9 conf) is in this file's header. Skip the step
	// rather than fail the whole gate on a deliberately-retired probe.
	console.log("skipped — probe-confidence.ts retired; see this file's header for the v0.6.0 overconfidence baseline.")

	console.log("")
	console.log(`Gate artifacts written to ${OUT}/. Apply the decision tree on the numbers above.`)
}

runIfScript(main)
