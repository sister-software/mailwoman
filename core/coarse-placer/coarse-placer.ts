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
