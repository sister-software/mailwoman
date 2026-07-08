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

import { $public } from "../env/index.js"
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
 * `scripts/coarse-placer/quantize.mjs`) sets `quantization: "int8-per-row"` and carries one `scale` per class, so
 * `weights.bin` can be a 4×-smaller `Int8Array` dequantized as `int8 * scales[class]`.
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
 * Dequantize a per-row int8 weight matrix back to fp32: `W[c][i] = int8[c*dim + i] * scales[c]`. The predict path stays
 * fp32 (identical math); quantization only shrinks the serialized/wire artifact. Pure — usable in the browser loader
 * too.
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
	/**
	 * Open-set reject rule (#244 M2). When `true`, the ABSTAIN decision uses the total IN-MAP probability mass `1 -
	 * P(OTHER)` instead of the single top-class prob, and a KEEP routes to the argmax IN-MAP class (never `OTHER`). This
	 * decouples "is it in-map at all?" (the reject question) from "which country?" (the routing question) — so a
	 * clearly-in-map-but-country-ambiguous address (mass split across several in-map countries) is KEPT rather than
	 * wrongly rejected. It clears the 90/90 the default max-prob rule cannot (post-hoc, no retrain: heldout-family
	 * generalization 89→91 — see docs/articles/evals/2026-06-14-coarse-placer-m2-openset.md). The returned `confidence`
	 * becomes the routed in-map country's marginal probability (the soft-prior posterior weight). Default `false` = the
	 * M1 max-prob rule (byte-stable; can still return `OTHER`).
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
	 * Load a placer from an artifact directory holding `meta.json` + `weights.bin` (the layout
	 * `scripts/coarse-placer/train.mjs` and `quantize.mjs` write). Handles both the fp32 artifact (`weights.bin` is a
	 * `Float32Array`) and the int8 artifact (`meta.quantization === "int8-per-row"`, `weights.bin` is an `Int8Array`
	 * dequantized via `meta.scales`). Node-only — the `node:` imports are dynamic so bundling the class for the browser
	 * doesn't pull them in.
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

	/**
	 * Load the int8 model bundled in `@mailwoman/core` (`core/data/coarse-placer/`). Node-only — uses the package path
	 * builder (the #481-corrected `__isCompiledTree` makes this resolve to the shipped `data/` in source, compiled, AND
	 * installed-package layouts). Override the directory with `$MAILWOMAN_COARSE_PLACER_DIR`. Callers set `abstainBelow`
	 * per their use (the soft-country-prior wiring passes 0.9 — see
	 * docs/articles/plan/2026-06-14-coarse-placer-soft-signal-spec.md).
	 */
	static async fromBundled(opts?: CoarsePlacerOpts): Promise<CoarsePlacer> {
		const dir = $public.MAILWOMAN_COARSE_PLACER_DIR

		if (dir) return CoarsePlacer.fromArtifactDir(dir, opts)
		const { corePackagePath } = await import("../utils/repo.js")

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
		// Numerically-stable softmax.
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
		// argmax + prob over the IN-MAP classes only (excludes OTHER) — used by the open-set rule.
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

		// Open-set rule (#244 M2): reject on total in-map MASS, route on the in-map argmax. Decouples
		// "is it in-map?" from "which country?". The posterior weight is the routed country's marginal.
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
 * The coarse placer's country POSTERIOR, shaped for the resolver: a per-country probability map like `{GB: 0.8, FR:
 * 0.06}` — "given this address text, how likely is each country?" ("posterior" in the Bayesian sense: the model's
 * belief AFTER seeing the input; see the glossary). Every in-map class except `OTHER` is included; returns `null` when
 * the model abstained or routed off-map. The resolver consumes it as `anchorPosterior`: each candidate's rank gains
 * `anchorWeight × posterior[candidate.country]`, so EVERY plausible country is boosted proportionally, and
 * country-ambiguous inputs (mass split DK↔NO) let the resolver's own place evidence break the tie — strictly more
 * informative than committing to the single argmax. Values are raw marginals in [0, 1] (un-renormalized; they sum to
 * the in-map mass `1 − P(OTHER)`), matching the one-hot `confidence` scale so `anchorWeight` needs no retuning.
 */
export function inMapPosterior(
	prediction: CoarsePrediction,
	opts?: {
		/**
		 * Epsilon floor (see the glossary): drop countries whose probability falls below this cutoff before the resolver
		 * sees the posterior, so implausible tails cannot influence ranking. Domain [0, 1]: `0` (the DEFAULT) passes the
		 * full distribution through unchanged; raising it keeps only stronger beliefs — at the extreme only the argmax
		 * survives (a one-hot). The default is 0 deliberately: the #928 investigation swept 0.05–0.30 against the misroute
		 * battery and every value was byte-identical (the drift's real cause was the anchor re-rank's score key, fixed
		 * separately) — no nonzero default has a measured basis, and the shipped distribution contract stays
		 * byte-identical. The knob exists for distribution-mode experiments (`--posterior-floor` on the misroute eval).
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

	// The argmax always survives (it is ≥ every other marginal; if even it fell below the floor the
	// prediction would have abstained upstream) — but guard anyway so the posterior is never empty.
	if (Object.keys(posterior).length === 0) {
		posterior[prediction.country] = prediction.confidence
	}

	return posterior
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
