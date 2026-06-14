/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #244 coarse-placer: a tiny always-resident linear classifier over hashed char-n-gram + script
 *   features ({@link featurize}). Maps an address string → a coarse country/region with a
 *   TEMPERATURE-CALIBRATED confidence, and ABSTAINS below a threshold ("probably off my loaded
 *   map") rather than emit a confident mis-placement. Pure + dependency-free — runs in node and the
 *   browser.
 */

import { COARSE_CLASSES, FEATURE_DIM, featurize } from "./featurize.js"

/** Serialized model: metadata in JSON, the dense `weights` (row-major [class][feature]) alongside. */
export interface CoarsePlacerArtifact {
	classes: readonly string[]
	featureDim: number
	/** Temperature for confidence calibration (logits are divided by this before softmax). */
	temperature: number
	bias: number[]
	/** Flat row-major weight matrix, length `classes.length * featureDim`. */
	weights: Float32Array
}

/**
 * On-disk `meta.json` shape. The fp32 artifact omits `quantization`/`scales`; the int8 artifact (from
 * `scripts/coarse-placer/quantize.mjs`) sets `quantization: "int8-per-row"` and carries one `scale`
 * per class, so `weights.bin` can be a 4×-smaller `Int8Array` dequantized as `int8 * scales[class]`.
 */
export interface CoarsePlacerMeta {
	classes: string[]
	featureDim: number
	temperature: number
	bias: number[]
	quantization?: "int8-per-row"
	/** Per-class dequantization scale; present iff `quantization === "int8-per-row"`. */
	scales?: number[]
}

/**
 * Dequantize a per-row int8 weight matrix back to fp32: `W[c][i] = int8[c*dim + i] * scales[c]`. The
 * predict path stays fp32 (identical math); quantization only shrinks the serialized/wire artifact.
 * Pure — usable in the browser loader too.
 */
export function dequantizeInt8Weights(
	int8: Int8Array,
	scales: readonly number[],
	classCount: number,
	dim: number
): Float32Array {
	const expected = classCount * dim
	if (int8.length !== expected) throw new Error(`dequantize: int8 length ${int8.length} ≠ classes×dim ${expected}`)
	if (scales.length !== classCount) throw new Error(`dequantize: ${scales.length} scales ≠ ${classCount} classes`)
	const out = new Float32Array(expected)
	for (let c = 0; c < classCount; c++) {
		const s = scales[c]!
		const base = c * dim
		for (let i = 0; i < dim; i++) out[base + i] = int8[base + i]! * s
	}
	return out
}

export interface CoarsePrediction {
	/** The predicted class, or `null` when the model abstained (confidence below the threshold). */
	country: string | null
	/** Calibrated probability of the top class (the abstention signal). */
	confidence: number
	abstained: boolean
	/** The full calibrated class distribution. */
	probs: Record<string, number>
}

export interface CoarsePlacerOpts {
	/** Abstain when the calibrated top-class confidence is below this (default 0.5). */
	abstainBelow?: number
}

export class CoarsePlacer {
	readonly #classes: readonly string[]
	readonly #dim: number
	readonly #temp: number
	readonly #bias: Float32Array
	readonly #weights: Float32Array
	readonly #threshold: number

	constructor(artifact: CoarsePlacerArtifact, opts: CoarsePlacerOpts = {}) {
		this.#classes = artifact.classes
		this.#dim = artifact.featureDim
		this.#temp = artifact.temperature || 1
		this.#bias = Float32Array.from(artifact.bias)
		this.#weights = artifact.weights
		this.#threshold = opts.abstainBelow ?? 0.5
		const expected = this.#classes.length * this.#dim
		if (this.#weights.length !== expected) {
			throw new Error(`CoarsePlacer: weights length ${this.#weights.length} ≠ classes×dim ${expected}`)
		}
	}

	/**
	 * Load a placer from an artifact directory holding `meta.json` + `weights.bin` (the layout
	 * `scripts/coarse-placer/train.mjs` and `quantize.mjs` write). Handles both the fp32 artifact
	 * (`weights.bin` is a `Float32Array`) and the int8 artifact (`meta.quantization === "int8-per-row"`,
	 * `weights.bin` is an `Int8Array` dequantized via `meta.scales`). Node-only — the `node:` imports are
	 * dynamic so bundling the class for the browser doesn't pull them in.
	 */
	static async fromArtifactDir(dir: string, opts?: CoarsePlacerOpts): Promise<CoarsePlacer> {
		const { readFile } = await import("node:fs/promises")
		const { join } = await import("node:path")
		const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as CoarsePlacerMeta
		const buf = await readFile(join(dir, "weights.bin"))
		// Copy out of the (possibly pooled, possibly mis-aligned) Buffer into a fresh ArrayBuffer so the
		// typed-array view is always validly aligned.
		const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
		let weights: Float32Array
		if (meta.quantization === "int8-per-row") {
			if (!meta.scales) throw new Error(`CoarsePlacer.fromArtifactDir: int8 artifact at ${dir} has no scales`)
			weights = dequantizeInt8Weights(new Int8Array(bytes), meta.scales, meta.classes.length, meta.featureDim)
		} else {
			weights = new Float32Array(bytes)
		}
		return new CoarsePlacer(
			{ classes: meta.classes, featureDim: meta.featureDim, temperature: meta.temperature, bias: meta.bias, weights },
			opts
		)
	}

	predict(text: string): CoarsePrediction {
		const feats = featurize(text)
		const C = this.#classes.length
		const logits = new Float32Array(C)
		for (let c = 0; c < C; c++) {
			let s = this.#bias[c]!
			const base = c * this.#dim
			for (const i of feats) s += this.#weights[base + i]!
			logits[c] = s / this.#temp
		}
		// Numerically-stable softmax.
		let maxLogit = -Infinity
		for (let c = 0; c < C; c++) if (logits[c]! > maxLogit) maxLogit = logits[c]!
		let sum = 0
		const probs = new Float32Array(C)
		for (let c = 0; c < C; c++) {
			const e = Math.exp(logits[c]! - maxLogit)
			probs[c] = e
			sum += e
		}
		let topIdx = 0
		let topProb = -1
		const distribution: Record<string, number> = {}
		for (let c = 0; c < C; c++) {
			const p = probs[c]! / sum
			distribution[this.#classes[c]!] = p
			if (p > topProb) {
				topProb = p
				topIdx = c
			}
		}
		const abstained = topProb < this.#threshold
		return {
			country: abstained ? null : this.#classes[topIdx]!,
			confidence: topProb,
			abstained,
			probs: distribution,
		}
	}
}

/** Load a coarse-placer from a JSON metadata file + a sibling `.weights.bin` (Float32). */
export async function loadCoarsePlacer(
	metaJson: { classes: string[]; featureDim: number; temperature: number; bias: number[] },
	weights: Float32Array,
	opts?: CoarsePlacerOpts
): Promise<CoarsePlacer> {
	return new CoarsePlacer({ ...metaJson, weights }, opts)
}

export { COARSE_CLASSES, FEATURE_DIM, featurize }
