/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A linear country classifier over hashed character n-gram and script features. Confidence is
 *   temperature-calibrated, and a prediction below the threshold abstains. The module runs in Node and browsers.
 */

import type { PathBuilderLike } from "path-ts"

import { featurize } from "#coarse-placer/featurize"
import { $public } from "#env/index"
import { readLocalBuffer, readLocalJSONFile } from "#fs/readers"

export { COARSE_CLASSES, FEATURE_DIM, featurize } from "#coarse-placer/featurize"

/**
 * The loaded model: class labels, calibration and fp32 weights.
 */
export interface CoarsePlacerArtifact {
	/**
	 * The class labels, including `OTHER`.
	 */
	classes: readonly string[]
	featureDim: number
	/**
	 * The temperature that divides logits before softmax.
	 */
	temperature: number
	/**
	 * The per-class bias added to the feature scores.
	 */
	bias: number[]
	/**
	 * The row-major weight matrix, with length `classes.length * featureDim`.
	 */
	weights: Float32Array
}

/**
 * The `meta.json` stored beside the model weights.
 *
 * Int8 artifacts set `quantization: "int8-per-row"` and `scales`.
 * Fp32 artifacts omit both.
 */
export interface CoarsePlacerMeta {
	classes: string[]
	featureDim: number
	temperature: number
	bias: number[]
	quantization?: "int8-per-row"
	/**
	 * The per-class scale for int8 weights.
	 */
	scales?: number[]
}

/**
 * Converts per-class int8 weights to fp32 by multiplying each row by its class scale.
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
 * Reads `weights.bin` into an array buffer that covers exactly the file's bytes.
 *
 * A Node `Buffer` can share a larger pooled buffer, so the result is sliced to the buffer's own range.
 */
export async function readWeightsBin(dir: PathBuilderLike): Promise<ArrayBufferLike> {
	const { PathBuilder } = await import("path-ts")
	const buf = await readLocalBuffer(PathBuilder.from(dir)("weights.bin"))

	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/**
 * One classifier prediction.
 */
export interface CoarsePrediction {
	/**
	 * The predicted class, or `null` when the prediction abstains.
	 */
	country: string | null
	/**
	 * The calibrated confidence that the abstention rule compares with the threshold.
	 */
	confidence: number
	abstained: boolean
	/**
	 * The calibrated probability of every class.
	 */
	probs: Record<string, number>
}

/**
 * Returns whether a prediction abstained or chose `OTHER`.
 */
export function isOffMapHandled(prediction: CoarsePrediction): boolean {
	return prediction.abstained || prediction.country === "OTHER"
}

/**
 * Options for {@linkcode CoarsePlacer}.
 */
export interface CoarsePlacerOpts {
	/**
	 * The minimum confidence for a prediction.
	 * The default is `0.5`.
	 */
	abstainBelow?: number
	/**
	 * Abstains on the total probability of in-map classes and otherwise returns the top in-map class.
	 *
	 * The default is `false`, which abstains on the top-class probability.
	 */
	openSet?: boolean
}

/**
 * The coarse country classifier.
 */
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
	 * Loads fp32 or per-row int8 weights from an artifact directory.
	 * This method requires Node.
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
	 * Loads the bundled model, or the artifact in `$MAILWOMAN_COARSE_PLACER_DIR` when it is set.
	 */
	static async fromBundled(opts?: CoarsePlacerOpts): Promise<CoarsePlacer> {
		const dir = $public.MAILWOMAN_COARSE_PLACER_DIR

		if (dir) return CoarsePlacer.fromArtifactDir(dir, opts)
		const { corePackagePath } = await import("#paths")

		return CoarsePlacer.fromArtifactDir(corePackagePath("data", "coarse-placer"), opts)
	}

	/**
	 * Classifies one address string.
	 */
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

		// Subtracting the largest logit keeps `Math.exp` from overflowing.
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
		// The in-map values track the most probable class other than `OTHER`.
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

		// Open-set mode abstains on total in-map probability and returns the top in-map class.
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
 * Returns the probabilities of the in-map classes without renormalizing them.
 *
 * Returns `null` when the prediction abstained or chose `OTHER`.
 * The resolver uses the result to rank candidates across countries.
 */
export function inMapPosterior(
	prediction: CoarsePrediction,
	opts?: {
		/**
		 * Classes below this probability are dropped.
		 * The default of `0` keeps every class.
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

	// When the floor removes every class, the predicted class is kept so the result is never empty.
	if (!Object.keys(posterior).length) {
		posterior[prediction.country] = prediction.confidence
	}

	return posterior
}

/**
 * Builds a coarse placer from metadata and fp32 weights.
 */
export async function loadCoarsePlacer(
	metaJson: { classes: string[]; featureDim: number; temperature: number; bias: number[] },
	weights: Float32Array,
	opts?: CoarsePlacerOpts
): Promise<CoarsePlacer> {
	return new CoarsePlacer({ ...metaJson, weights }, opts)
}
