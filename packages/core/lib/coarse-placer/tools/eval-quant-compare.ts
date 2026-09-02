/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Accuracy cost of the #244 coarse-placer int8 quantization (milestone 3). Runs the held-out test
 *   split through the fp32 model and the int8 model (dequantized inline) and reports overall + per-
 *   class accuracy for each, the delta, prediction-agreement rate, and confidence MAE. Check: int8
 *   within ~1pp of fp32 (the milestone target).
 *
 *   Run: `mailwoman placer eval quant-compare [--fp32 <dir>] [--int8 <dir>] [--abstain 0.5]`
 */

import { type PathBuilderLike, resolvePath, resolvePathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { CoarsePlacer, type CoarsePlacerMeta } from "#coarse-placer/coarse-placer"
import { defaultDataDir, defaultInt8Dir, defaultModelDir } from "#coarse-placer/tools/paths"
import { readLocalJSONFile } from "#fs/readers"

interface TestRow {
	raw: string
	country: string
}

/**
 * Options for {@linkcode evalQuantCompare}.
 */
export interface EvalQuantCompareOptions {
	/**
	 * Fp32 artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`.
	 */
	fp32?: PathBuilderLike
	/**
	 * Int8 artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model-int8`.
	 */
	int8?: PathBuilderLike
	/**
	 * Abstention threshold. Default 0.5.
	 */
	abstain?: number
	/**
	 * Dataset dir (`test.jsonl`). Default `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
}

/**
 * Result of {@linkcode evalQuantCompare}.
 */
export interface EvalQuantCompareResult {
	n: number
	/**
	 * Fp32 overall accuracy in percent.
	 */
	accFp32: number
	/**
	 * Int8 overall accuracy in percent.
	 */
	accInt8: number
	/**
	 * Whether int8 is within 1pp of fp32 (the threshold).
	 */
	pass: boolean
}

/**
 * Coarse-placer int8-vs-fp32 comparison — see the module doc. Emits the report to stdout.
 */
export async function evalQuantCompare(options: EvalQuantCompareOptions = {}): Promise<EvalQuantCompareResult> {
	const fp32Dir = resolvePathBuilder(options.fp32 || defaultModelDir())
	const int8Dir = resolvePathBuilder(options.int8 || defaultInt8Dir())
	const abstainBelow = options.abstain ?? 0.5
	const dataDir = options.data || defaultDataDir()

	const fp32 = await CoarsePlacer.fromArtifactDir(resolvePath(fp32Dir), { abstainBelow })
	const int8 = await CoarsePlacer.fromArtifactDir(resolvePath(int8Dir), { abstainBelow })

	const test = await Array.fromAsync(JSONSpliterator.fromAsync<TestRow>(resolvePath(dataDir, "test.jsonl")))

	const classes = (await readLocalJSONFile<CoarsePlacerMeta>(resolvePath(fp32Dir, "meta.json"))).classes
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

	const pass = Math.abs(accI - accF) <= 1

	console.log(`  gate: ${pass ? "PASS (within 1pp)" : "FAIL (>1pp drop)"}`)

	return { n: N, accFp32: accF, accInt8: accI, pass }
}
