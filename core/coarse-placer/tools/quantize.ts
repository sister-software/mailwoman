/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Int8-quantize the #244 coarse-placer (milestone 3). The placer is a linear classifier, so the
 *   only weight is a dense [class][feature] fp32 matrix (12×65536 = 3.0 MB). Per-CLASS symmetric
 *   int8 quantization — `scale[c] = max(|W[c]|) / 127`, `q = round(W / scale)` clamped to [-127,
 *   127] — shrinks it to 0.75 MB (4×) while preserving the linear math exactly up to rounding (the
 *   logit is `bias[c] + scale[c] * Σ int8`, dequantized on load by `CoarsePlacer.fromArtifactDir`).
 *   Per-class scales matter because class weight magnitudes differ (OTHER's outlier-exposure rows
 *   push bigger weights than the in-map countries).
 *
 *   Verify the accuracy cost with `mailwoman placer eval quant-compare` (target: within ~1pp).
 *
 *   Run: `mailwoman placer quantize [--in <fp32 dir>] [--out <int8 dir>]`
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { dataRootPath } from "../../utils/data-root.ts"
import type { CoarsePlacerMeta } from "../coarse-placer.ts"

/** Options for {@linkcode quantizeCoarsePlacer}. */
export interface QuantizeCoarsePlacerOptions {
	/** Fp32 artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`. */
	in?: string
	/** Int8 output dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model-int8`. */
	out?: string
}

/** Result of {@linkcode quantizeCoarsePlacer}. */
export interface QuantizeCoarsePlacerResult {
	outDir: string
	fp32Bytes: number
	int8Bytes: number
	maxAbsErr: number
	rmse: number
}

/** Coarse-placer int8 quantizer — see the module doc. */
export async function quantizeCoarsePlacer(
	options: QuantizeCoarsePlacerOptions = {},
	report?: (line: string) => void
): Promise<QuantizeCoarsePlacerResult> {
	const inDir = options.in || dataRootPath("coarse-placer", "model")
	const outDir = options.out || dataRootPath("coarse-placer", "model-int8")

	const meta = JSON.parse(readFileSync(path.join(inDir, "meta.json"), "utf8")) as CoarsePlacerMeta
	const buf = readFileSync(path.join(inDir, "weights.bin"))
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
	const w = new Float32Array(ab)
	const C = meta.classes.length
	const dim = meta.featureDim

	if (w.length !== C * dim) throw new Error(`weights length ${w.length} ≠ classes×dim ${C * dim}`)

	const int8 = new Int8Array(C * dim)
	const scales: number[] = []
	let maxAbsErr = 0
	let sumSqErr = 0

	for (let c = 0; c < C; c++) {
		const base = c * dim
		let maxAbs = 0

		for (let i = 0; i < dim; i++) {
			const a = Math.abs(w[base + i]!)

			if (a > maxAbs) {
				maxAbs = a
			}
		}
		const scale = maxAbs / 127 || 1 // all-zero row → scale 1 (q stays 0)
		scales.push(scale)

		for (let i = 0; i < dim; i++) {
			let q = Math.round(w[base + i]! / scale)

			if (q > 127) {
				q = 127
			} else if (q < -127) {
				q = -127
			} // symmetric range; avoid -128 so |q|≤127
			int8[base + i] = q
			const err = Math.abs(q * scale - w[base + i]!)

			if (err > maxAbsErr) {
				maxAbsErr = err
			}
			sumSqErr += err * err
		}
	}

	mkdirSync(outDir, { recursive: true })
	writeFileSync(path.join(outDir, "weights.bin"), Buffer.from(int8.buffer))
	writeFileSync(
		path.join(outDir, "meta.json"),
		JSON.stringify({ ...meta, quantization: "int8-per-row", scales }, null, 2)
	)

	const fp32Bytes = w.length * 4
	const int8Bytes = int8.length
	const rmse = Math.sqrt(sumSqErr / w.length)
	report?.(`coarse-placer int8 quantization`)
	report?.(`  in:  ${inDir}`)
	report?.(`  out: ${outDir}`)
	report?.(
		`  weights: ${(fp32Bytes / 1e6).toFixed(2)} MB fp32 → ${(int8Bytes / 1e6).toFixed(2)} MB int8 (${(fp32Bytes / int8Bytes).toFixed(1)}×)`
	)
	report?.(`  per-class scales: [${scales.map((s) => s.toExponential(2)).join(", ")}]`)
	report?.(`  weight reconstruction error: max ${maxAbsErr.toExponential(2)}, rmse ${rmse.toExponential(2)}`)

	return { outDir, fp32Bytes, int8Bytes, maxAbsErr, rmse }
}
