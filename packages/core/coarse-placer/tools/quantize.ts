import * as path from "@mailwoman/platform/path"

import { readLocalBuffer, readLocalJSONFile } from "#fs/readers"
import { makeDirectories, writeLocalBuffer, writeLocalJSONFile } from "#fs/writers"
import { dataRootPath } from "#utils"

import type { CoarsePlacerMeta } from "../coarse-placer.ts"

/**
 * Largest magnitude representable in the symmetric int8 range the weights quantize into.
 */
const INT8_MAX = 127

/**
 * Options for {@linkcode quantizeCoarsePlacer}.
 */
export interface QuantizeCoarsePlacerOptions {
	/**
	 * Fp32 artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`.
	 */
	in?: string
	/**
	 * Int8 output dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model-int8`.
	 */
	out?: string
}

/**
 * Result of {@linkcode quantizeCoarsePlacer}.
 */
export interface QuantizeCoarsePlacerResult {
	outDir: string
	fp32Bytes: number
	int8Bytes: number
	maxAbsErr: number
	rmse: number
}

/**
 * Coarse-placer int8 quantizer — see the module doc.
 */
export async function quantizeCoarsePlacer(
	options: QuantizeCoarsePlacerOptions = {},
	report?: (line: string) => void
): Promise<QuantizeCoarsePlacerResult> {
	const inDir = options.in || dataRootPath("coarse-placer", "model")
	const outDir = options.out || dataRootPath("coarse-placer", "model-int8")

	const meta = await readLocalJSONFile<CoarsePlacerMeta>(path.join(inDir, "meta.json"))
	const buf = await readLocalBuffer(path.join(inDir, "weights.bin"))
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

			if (q > INT8_MAX) {
				q = 127
			} else if (q < -INT8_MAX) {
				q = -127
			}

			// symmetric range; avoid -128 so |q|≤127
			int8[base + i] = q
			const err = Math.abs(q * scale - w[base + i]!)

			if (err > maxAbsErr) {
				maxAbsErr = err
			}

			sumSqErr += err * err
		}
	}

	await makeDirectories(outDir)
	await writeLocalBuffer(Buffer.from(int8.buffer), path.join(outDir, "weights.bin"))

	await writeLocalJSONFile({ ...meta, quantization: "int8-per-row", scales }, path.join(outDir, "meta.json"))

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
