import { readFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Accuracy cost of the #244 coarse-placer int8 quantization (milestone 3). Runs the held-out test
 *   split through the fp32 model and the int8 model (dequantized inline) and reports overall + per-
 *   class accuracy for each, the delta, prediction-agreement rate, and confidence MAE. Gate: int8
 *   within ~1pp of fp32 (the milestone target). Uses the already-compiled `core/out` CoarsePlacer
 *   constructor, so it needs no recompile to validate a fresh quantization.
 *
 *   Usage: node scripts/coarse-placer/eval-quant-compare.ts [--fp32 <dir>] [--int8 <dir>] [--abstain
 *   0.5]
 */
import { dataRootPath } from "@mailwoman/core/utils"

import type { CoarsePlacer as CoarsePlacerClass, CoarsePlacerMeta } from "../../core/coarse-placer/coarse-placer.ts"

interface TestRow {
	raw: string
	country: string
}

const root = new URL("../../", import.meta.url)
const { CoarsePlacer } = (await import(
	new URL("core/out/coarse-placer/coarse-placer.js", root).href
)) as typeof import("../../core/coarse-placer/coarse-placer.ts")

const { values: args } = parseArgs({
	options: {
		fp32: { type: "string", default: dataRootPath("coarse-placer", "model") },
		int8: { type: "string", default: dataRootPath("coarse-placer", "model-int8") },
		abstain: { type: "string", default: "0.5" },
		data: { type: "string", default: path.resolve(import.meta.dirname, "../../data/coarse-placer") },
	},
})
const abstainBelow = Number(args.abstain)

function loadFp32(dir: string): CoarsePlacerClass {
	const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as CoarsePlacerMeta
	const buf = readFileSync(path.join(dir, "weights.bin"))
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
	const weights = new Float32Array(ab)

	return new CoarsePlacer({ ...meta, weights }, { abstainBelow })
}
function loadInt8(dir: string): CoarsePlacerClass {
	const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as CoarsePlacerMeta
	const buf = readFileSync(path.join(dir, "weights.bin"))
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
	const int8 = new Int8Array(ab)
	const C = meta.classes.length
	const dim = meta.featureDim
	const scales = meta.scales!
	const weights = new Float32Array(C * dim)

	for (let c = 0; c < C; c++) {
		const s = scales[c]!
		const base = c * dim

		for (let i = 0; i < dim; i++) {
			weights[base + i] = int8[base + i]! * s
		}
	}

	return new CoarsePlacer({ ...meta, weights }, { abstainBelow })
}

const fp32 = loadFp32(args.fp32)
const int8 = loadInt8(args.int8)

const test: TestRow[] = readFileSync(path.join(args.data, "test.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as TestRow)

const classes = (JSON.parse(readFileSync(path.join(args.fp32, "meta.json"), "utf8")) as CoarsePlacerMeta).classes
let okF = 0
let okI = 0
let agree = 0
let confMae = 0
const perF: Record<string, { n: number; ok: number }> = {}
const perI: Record<string, { n: number; ok: number }> = {}

for (const r of test) {
	const pf = fp32.predict(r.raw)
	const pi = int8.predict(r.raw)
	const cf = pf.country ?? "(abstain)"
	const ci = pi.country ?? "(abstain)"
	;(perF[r.country] ??= { n: 0, ok: 0 }).n++
	;(perI[r.country] ??= { n: 0, ok: 0 }).n++

	if (cf === r.country) {
		okF++
		perF[r.country]!.ok++
	}

	if (ci === r.country) {
		okI++
		perI[r.country]!.ok++
	}

	if (cf === ci) {
		agree++
	}
	confMae += Math.abs(pf.confidence - pi.confidence)
}
const N = test.length
const accF = (100 * okF) / N
const accI = (100 * okI) / N
console.log(`coarse-placer int8 vs fp32 — test n=${N} (abstain ${abstainBelow})`)
console.log(
	`  overall accuracy:  fp32 ${accF.toFixed(2)}%   int8 ${accI.toFixed(2)}%   Δ ${(accI - accF >= 0 ? "+" : "") + (accI - accF).toFixed(2)}pp`
)
console.log(`  prediction agreement (same top class): ${((100 * agree) / N).toFixed(2)}%`)
console.log(`  confidence MAE: ${(confMae / N).toFixed(4)}`)
console.log(`  per-class recall (fp32 → int8):`)

for (const c of classes) {
	const f = perF[c]
	const i = perI[c]!

	if (!f) continue
	const rf = (100 * f.ok) / f.n
	const ri = (100 * i.ok) / i.n
	console.log(
		`    ${c.padEnd(6)} ${rf.toFixed(1)}% → ${ri.toFixed(1)}%  (Δ ${(ri - rf >= 0 ? "+" : "") + (ri - rf).toFixed(1)}pp, n=${f.n})`
	)
}
const verdict = Math.abs(accI - accF) <= 1.0 ? "PASS (within 1pp)" : "FAIL (>1pp drop)"
console.log(`  gate: ${verdict}`)
