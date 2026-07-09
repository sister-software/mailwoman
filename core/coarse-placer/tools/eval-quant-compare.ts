/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Accuracy cost of the #244 coarse-placer int8 quantization (milestone 3). Runs the held-out test
 *   split through the fp32 model and the int8 model (dequantized inline) and reports overall + per-
 *   class accuracy for each, the delta, prediction-agreement rate, and confidence MAE. Gate: int8
 *   within ~1pp of fp32 (the milestone target).
 *
 *   Run: `mailwoman placer eval quant-compare [--fp32 <dir>] [--int8 <dir>] [--abstain 0.5]`
 */

import { readFileSync } from "node:fs"
import * as path from "node:path"

import { dataRootPath } from "../../utils/data-root.ts"
import { repoRootPath } from "../../utils/repo.ts"
import { CoarsePlacer, type CoarsePlacerMeta } from "../coarse-placer.ts"

interface TestRow {
	raw: string
	country: string
}

/** Options for {@linkcode evalQuantCompare}. */
export interface EvalQuantCompareOptions {
	/** Fp32 artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`. */
	fp32?: string
	/** Int8 artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model-int8`. */
	int8?: string
	/** Abstention threshold. Default 0.5. */
	abstain?: number
	/** Dataset dir (`test.jsonl`). Default `<repo>/data/coarse-placer`. */
	data?: string
}

/** Result of {@linkcode evalQuantCompare}. */
export interface EvalQuantCompareResult {
	n: number
	/** Fp32 overall accuracy in percent. */
	accFp32: number
	/** Int8 overall accuracy in percent. */
	accInt8: number
	/** Whether int8 is within 1pp of fp32 (the gate). */
	pass: boolean
}

/** Coarse-placer int8-vs-fp32 comparison — see the module doc. Emits the report to stdout. */
export async function evalQuantCompare(options: EvalQuantCompareOptions = {}): Promise<EvalQuantCompareResult> {
	const fp32Dir = options.fp32 || dataRootPath("coarse-placer", "model")
	const int8Dir = options.int8 || dataRootPath("coarse-placer", "model-int8")
	const abstainBelow = options.abstain ?? 0.5
	const dataDir = options.data || repoRootPath("data", "coarse-placer")

	function loadFp32(dir: string): CoarsePlacer {
		const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as CoarsePlacerMeta
		const buf = readFileSync(path.join(dir, "weights.bin"))
		const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
		const weights = new Float32Array(ab)

		return new CoarsePlacer({ ...meta, weights }, { abstainBelow })
	}
	function loadInt8(dir: string): CoarsePlacer {
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

	const fp32 = loadFp32(fp32Dir)
	const int8 = loadInt8(int8Dir)

	const test: TestRow[] = readFileSync(path.join(dataDir, "test.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as TestRow)

	const classes = (JSON.parse(readFileSync(path.join(fp32Dir, "meta.json"), "utf8")) as CoarsePlacerMeta).classes
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
	const pass = Math.abs(accI - accF) <= 1.0
	console.log(`  gate: ${pass ? "PASS (within 1pp)" : "FAIL (>1pp drop)"}`)

	return { n: N, accFp32: accF, accInt8: accI, pass }
}
