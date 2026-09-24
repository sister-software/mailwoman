/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lightweight country/region classifier using hashed character n-gram and script features.
 *   Confidence is temperature-calibrated; low-confidence predictions can abstain. The module runs
 *   in Node and browsers.
 */

import type { PathBuilderLike } from "path-ts"

import { featurize } from "#coarse-placer/featurize"
import { $public } from "#env/index"
import { readLocalBuffer, readLocalJSONFile } from "#fs/readers"

export { COARSE_CLASSES, FEATURE_DIM, featurize } from "#coarse-placer/featurize"

export interface CoarsePlacerArtifact {
	/**
	 * Country or region labels predicted by the model.
	 */
	classes: readonly string[]
	featureDim: number
	/**
	 * Calibration temperature applied to logits before softmax.
	 */
	temperature: number
	/**
	 * Per-class bias added to the feature scores before softmax.
	 */
	bias: number[]
	/**
	 * Flat row-major weight matrix, length `classes.length * featureDim`.
	 */
	weights: Float32Array
}

/**
 * Metadata stored beside model weights.
 *
 * Int8 artifacts specify per-class scales and `quantization: "int8-per-row"`;
 * fp32 artifacts omit those fields.
 */
export interface CoarsePlacerMeta {
	classes: string[]
	featureDim: number
	temperature: number
	bias: number[]
	quantization?: "int8-per-row"
	/**
	 * Per-class scale, present for int8 weights.
	 */
	scales?: number[]
}

/**
 * Convert per-class int8 weights to fp32 using the class's scale.
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

		for (let i = 0; i < dim; i++) {
			out[base + i] = int8[base + i]! * s
		}
	}

	return out
}

/**
 * Read `weights.bin` into a buffer with the correct byte offset and length.
 */
export async function readWeightsBin(dir: PathBuilderLike): Promise<ArrayBufferLike> {
	const { PathBuilder } = await import("path-ts")
	const buf = await readLocalBuffer(PathBuilder.from(dir)("weights.bin"))

	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

export interface CoarsePrediction {
	/**
	 * Predicted class, or `null` when confidence is below the threshold.
	 */
	country: string | null
	/**
	 * Calibrated confidence used by the abstention rule.
	 */
	confidence: number
	abstained: boolean
	/**
	 * The full calibrated class distribution.
	 */
	probs: Record<string, number>
}

/**
 * Return whether an off-map input was routed to `OTHER` or rejected.
 */
export function isOffMapHandled(prediction: CoarsePrediction): boolean {
	return prediction.abstained || prediction.country === "OTHER"
}

export interface CoarsePlacerOpts {
	/**
	 * Minimum confidence required to return a prediction.
	 * Defaults to `0.5`.
	 */
	abstainBelow?: number
	/**
	 * Reject using total in-map probability rather than the top-class probability,
	 * then route to the highest-probability in-map class.
	 * Defaults to `false`.
	 */
	openSet?: boolean
}

export class CoarsePlacer {
	readonly #classes: readonly string[]
	readonly #dim: number
	readonly #temp: number
	readonly #bias: Float32Array
	readonly #weights: Float32Array
	readonly #threshold: number
	readonly #openSet: boolean

	constructor(artifact: CoarsePlacerArtifact, opts: CoarsePlacerOpts = {}) {
		this.#classes = artifact.classes
		this.#dim = artifact.featureDim
		this.#temp = artifact.temperature || 1
		this.#bias = Float32Array.from(artifact.bias)
		this.#weights = artifact.weights
		this.#threshold = opts.abstainBelow ?? 0.5
		this.#openSet = opts.openSet ?? false
		const expected = this.#classes.length * this.#dim

		if (this.#weights.length !== expected) {
			throw new Error(`CoarsePlacer: weights length ${this.#weights.length} ≠ classes×dim ${expected}`)
		}
	}

	/**
	 * Load fp32 or per-row int8 weights from an artifact directory.
	 * This method is Node-only.
	 */
	static async fromArtifactDir(dir: PathBuilderLike, opts?: CoarsePlacerOpts): Promise<CoarsePlacer> {
		const { PathBuilder } = await import("path-ts")
		const meta = await readLocalJSONFile<CoarsePlacerMeta>(PathBuilder.from(dir)("meta.json"))
		const bytes = await readWeightsBin(dir)
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

	/**
	 * Load the bundled model, or use `$MAILWOMAN_COARSE_PLACER_DIR` to select another artifact.
	 */
	static async fromBundled(opts?: CoarsePlacerOpts): Promise<CoarsePlacer> {
		const dir = $public.MAILWOMAN_COARSE_PLACER_DIR

		if (dir) return CoarsePlacer.fromArtifactDir(dir, opts)
		const { corePackagePath } = await import("#paths")

		return CoarsePlacer.fromArtifactDir(corePackagePath("data", "coarse-placer"), opts)
	}

	predict(text: string): CoarsePrediction {
		const feats = featurize(text)
		const C = this.#classes.length
		const logits = new Float32Array(C)

		for (let c = 0; c < C; c++) {
			let s = this.#bias[c]!
			const base = c * this.#dim

			for (const i of feats) {
				s += this.#weights[base + i]!
			}

			logits[c] = s / this.#temp
		}

		// Preserve the fp32 exponent rounding used by the inference path.
		let maxLogit = -Infinity

		for (let c = 0; c < C; c++)
			if (logits[c]! > maxLogit) {
				maxLogit = logits[c]!
			}

		let sum = 0
		const probs = new Float32Array(C)

		for (let c = 0; c < C; c++) {
			const e = Math.exp(logits[c]! - maxLogit)
			probs[c] = e
			sum += e
		}

		let topIdx = 0
		let topProb = -1
		let otherProb = 0
		// Track the highest-probability class other than `OTHER`.
		let inMapIdx = -1
		let inMapProb = -1
		const distribution: Record<string, number> = {}

		for (let c = 0; c < C; c++) {
			const p = probs[c]! / sum
			distribution[this.#classes[c]!] = p

			if (p > topProb) {
				topProb = p
				topIdx = c
			}

			if (this.#classes[c] === "OTHER") {
				otherProb = p
			} else if (p > inMapProb) {
				inMapProb = p
				inMapIdx = c
			}
		}

		// Open-set mode rejects on total in-map mass and routes to the in-map argmax.
		if (this.#openSet) {
			const inMapMass = 1 - otherProb
			const abstained = inMapMass < this.#threshold

			return {
				country: abstained || inMapIdx < 0 ? null : this.#classes[inMapIdx]!,
				confidence: abstained ? inMapMass : inMapProb,
				abstained,
				probs: distribution,
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

/**
 * Return the unnormalized probabilities for all in-map classes, or `null`
 * when prediction abstains or selects `OTHER`.
 *
 * The resolver can use the distribution to rank candidates across countries.
 */
export function inMapPosterior(
	prediction: CoarsePrediction,
	opts?: {
		/**
		 * Exclude classes below this probability.
		 * Defaults to `0`, which preserves the full distribution.
		 */
		epsilonFloor?: number
	}
): Record<string, number> | null {
	if (prediction.country === null || prediction.country === "OTHER") return null
	const floor = opts?.epsilonFloor ?? 0
	const posterior: Record<string, number> = {}

	for (const [cls, prob] of Object.entries(prediction.probs)) {
		if (cls !== "OTHER" && prob >= floor) {
			posterior[cls] = prob
		}
	}

	// Preserve a non-empty result if all classes were filtered.
	if (!Object.keys(posterior).length) {
		posterior[prediction.country] = prediction.confidence
	}

	return posterior
}

/**
 * Build a coarse placer from metadata and fp32 weights.
 */
export async function loadCoarsePlacer(
	metaJson: { classes: string[]; featureDim: number; temperature: number; bias: number[] },
	weights: Float32Array,
	opts?: CoarsePlacerOpts
): Promise<CoarsePlacer> {
	return new CoarsePlacer({ ...metaJson, weights }, opts)
}
