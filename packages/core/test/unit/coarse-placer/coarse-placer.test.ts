/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the coarse placer's featurizer, artifact loading, int8 dequantization, abstention and posterior filtering.
 */

import {
	CoarsePlacer,
	dequantizeInt8Weights,
	FEATURE_DIM,
	featurize,
	inMapPosterior,
} from "@mailwoman/core/coarse-placer"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalBuffer, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { makeLcg } from "@mailwoman/core/random"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, test } from "vitest"

const tmpRoot = await temporaryDirectory("coarse-placer-test-")
afterAll(() => tmpRoot[Symbol.asyncDispose]())

/**
 * Generates seeded weights in `[-0.05, 0.05)`.
 */
function seededWeights(classCount: number, dim: number, seed: number): Float32Array {
	const w = new Float32Array(classCount * dim)
	const next = makeLcg(seed)

	for (let i = 0; i < w.length; i++) {
		w[i] = (next() - 0.5) * 0.1
	}

	return w
}

/**
 * Quantizes each row symmetrically to int8 with a per-row scale.
 */
function quantize(w: Float32Array, classCount: number, dim: number) {
	const int8 = new Int8Array(classCount * dim)
	const scales: number[] = []

	for (let c = 0; c < classCount; c++) {
		const base = c * dim
		let maxAbs = 0

		for (let i = 0; i < dim; i++) {
			maxAbs = Math.max(maxAbs, Math.abs(w[base + i]!))
		}

		const scale = maxAbs / 127 || 1
		scales.push(scale)

		for (let i = 0; i < dim; i++) {
			int8[base + i] = Math.max(-127, Math.min(127, Math.round(w[base + i]! / scale)))
		}
	}

	return { int8, scales }
}

/**
 * Writes fp32 and int8 artifact directories for the same weights.
 */
async function writeArtifacts(
	classes: string[],
	dim: number,
	weights: Float32Array,
	bias: number[],
	temperature = 1
): Promise<{ fp32Dir: PathBuilder; int8Dir: PathBuilder }> {
	const fp32Dir = tmpRoot.path(`fp32-${classes.join("")}-${dim}`)
	const int8Dir = tmpRoot.path(`int8-${classes.join("")}-${dim}`)
	await makeDirectories(fp32Dir)
	await makeDirectories(int8Dir)

	const baseMeta = { classes, featureDim: dim, temperature, bias }
	await writeLocalJSONFile(baseMeta, fp32Dir("meta.json"))

	await writeLocalBuffer(Buffer.from(weights.buffer, weights.byteOffset, weights.byteLength), fp32Dir("weights.bin"))

	const { int8, scales } = quantize(weights, classes.length, dim)
	await writeLocalJSONFile({ ...baseMeta, quantization: "int8-per-row", scales }, int8Dir("meta.json"))
	await writeLocalBuffer(Buffer.from(int8.buffer), int8Dir("weights.bin"))

	return { fp32Dir, int8Dir }
}

describe("featurize", () => {
	test("is deterministic and bounded", () => {
		const a = featurize("123 Main St, Springfield")
		const b = featurize("123 Main St, Springfield")
		expect(a).toEqual(b)
		expect(a.length).toBeGreaterThan(0)

		for (const i of a) {
			expect(i).toBeGreaterThanOrEqual(0)
			expect(i).toBeLessThan(FEATURE_DIM)
		}
	})

	test("empty / whitespace input yields no features", () => {
		expect(featurize("")).toEqual([])
		expect(featurize("   ")).toEqual([])
	})

	test("different scripts produce different feature sets", () => {
		const latin = new Set(featurize("Main Street"))
		const cyrillic = new Set(featurize("Тверская улица"))
		expect([...cyrillic].some((i) => !latin.has(i))).toBe(true)
	})
})

describe("dequantizeInt8Weights", () => {
	test("reconstructs W = int8 * scale per row", () => {
		const int8 = Int8Array.from([127, -127, 0, 64, 10, -10, 100, -50])
		const scales = [0.01, 0.5]
		const out = dequantizeInt8Weights(int8, scales, 2, 4)

		// The tolerance absorbs Float32 rounding.
		for (const [i, want] of [1.27, -1.27, 0, 0.64].entries()) {
			expect(out[i]).toBeCloseTo(want, 6)
		}

		expect(out[4]).toBeCloseTo(5, 6)
		expect(out[7]).toBeCloseTo(-25, 6)
	})

	test("rejects length / scale-count mismatch", async () => {
		expect(() => dequantizeInt8Weights(new Int8Array(8), [1], 2, 4)).toThrow(/dequantize:/)
		expect(() => dequantizeInt8Weights(new Int8Array(7), [1, 1], 2, 4)).toThrow(/dequantize:/)
	})
})

// The artifacts are written at module level because `describe` callbacks cannot await.
const ARTIFACT_CLASSES = ["AA", "BB", "CC"]
const ARTIFACT_BIAS = [0.1, -0.2, 0.05]
const ARTIFACT_WEIGHTS = seededWeights(ARTIFACT_CLASSES.length, FEATURE_DIM, 12_345)
const { fp32Dir, int8Dir } = await writeArtifacts(ARTIFACT_CLASSES, FEATURE_DIM, ARTIFACT_WEIGHTS, ARTIFACT_BIAS)

describe("CoarsePlacer.fromArtifactDir", () => {
	const classes = ARTIFACT_CLASSES
	const bias = ARTIFACT_BIAS
	const samples = ["123 Main St", "10 Rue de la Paix", "1-2-3 Chiyoda Tokyo", "Calle Mayor 7"]

	test("loads the fp32 artifact and predicts", async () => {
		const placer = await CoarsePlacer.fromArtifactDir(fp32Dir, { abstainBelow: 0 })

		for (const s of samples) {
			const p = placer.predict(s)
			expect(classes).toContain(p.country)
			expect(p.confidence).toBeGreaterThan(0)
			const total = Object.values(p.probs).reduce((a, b) => a + b, 0)
			expect(total).toBeCloseTo(1, 5)
		}
	})

	test("int8 artifact predicts the same class with near-identical confidence", async () => {
		const fp32 = await CoarsePlacer.fromArtifactDir(fp32Dir, { abstainBelow: 0 })
		const int8 = await CoarsePlacer.fromArtifactDir(int8Dir, { abstainBelow: 0 })

		for (const s of samples) {
			const a = fp32.predict(s)
			const b = int8.predict(s)
			expect(b.country).toBe(a.country)
			expect(b.confidence).toBeCloseTo(a.confidence, 2)
		}
	})

	test("int8 artifact missing scales is rejected", async () => {
		const badDir = tmpRoot.path("int8-noscales")
		await makeDirectories(badDir)

		await writeLocalJSONFile(
			{ classes, featureDim: FEATURE_DIM, temperature: 1, bias, quantization: "int8-per-row" },
			badDir("meta.json")
		)

		await writeLocalBuffer(Buffer.from(new Int8Array(classes.length * FEATURE_DIM).buffer), badDir("weights.bin"))
		await expect(CoarsePlacer.fromArtifactDir(badDir)).rejects.toThrow(/scales/)
	})
})

describe("open-set reject rule (#244 M2)", () => {
	// Zero weights make each prediction depend only on the bias.
	const classes = ["US", "FR", "OTHER"]
	const dim = FEATURE_DIM

	const make = (bias: number[], opts: { abstainBelow?: number; openSet?: boolean }) =>
		new CoarsePlacer(
			{ classes, featureDim: dim, temperature: 1, bias, weights: new Float32Array(classes.length * dim) },
			opts
		)

	test("keeps an in-map-but-country-ambiguous address the max-prob rule rejects", () => {
		// The top class has probability 0.4, and the in-map classes together have 0.8.
		const bias = [Math.log(0.4), Math.log(0.4), Math.log(0.2)]
		const def = make(bias, { abstainBelow: 0.5 })
		const open = make(bias, { abstainBelow: 0.5, openSet: true })

		const d = def.predict("x")
		expect(d.abstained).toBe(true)
		expect(d.country).toBeNull()

		const o = open.predict("x")
		expect(o.abstained).toBe(false)
		expect(o.country).toBe("US")
		expect(o.confidence).toBeCloseTo(0.4, 5)
	})

	test("rejects to null (never 'OTHER' as a country) when off-map mass dominates", () => {
		const bias = [Math.log(0.1), Math.log(0.1), Math.log(0.8)]
		const def = make(bias, { abstainBelow: 0.5 })
		const open = make(bias, { abstainBelow: 0.5, openSet: true })

		expect(def.predict("x").country).toBe("OTHER")
		const o = open.predict("x")
		expect(o.abstained).toBe(true)
		expect(o.country).toBeNull()
	})

	test("openSet off is byte-stable (top-class rule unchanged)", () => {
		const bias = [Math.log(0.6), Math.log(0.2), Math.log(0.2)]
		const p = make(bias, { abstainBelow: 0.5 }).predict("x")
		expect(p.country).toBe("US")
		expect(p.confidence).toBeCloseTo(0.6, 5)
	})
})

describe("abstention", () => {
	test("abstains when no class clears the threshold", () => {
		// Four equal logits give each class probability 0.25.
		const classes = ["AA", "BB", "CC", "DD"]

		const placer = new CoarsePlacer(
			{
				classes,
				featureDim: FEATURE_DIM,
				temperature: 1,
				bias: [0, 0, 0, 0],
				weights: new Float32Array(classes.length * FEATURE_DIM),
			},
			{ abstainBelow: 0.5 }
		)

		const p = placer.predict("anything at all")
		expect(p.abstained).toBe(true)
		expect(p.country).toBeNull()
		expect(p.confidence).toBeCloseTo(0.25, 5)
	})
})

describe("inMapPosterior — #928 epsilon floor", () => {
	const pred = {
		country: "GB",
		confidence: 0.8,
		abstained: false,
		probs: { GB: 0.8, US: 0.04, FR: 0.06, OTHER: 0.1 },
	}

	test("DEFAULT floor is 0 — the full distribution passes through (the shipped interface)", () => {
		expect(inMapPosterior(pred)).toEqual({ GB: 0.8, US: 0.04, FR: 0.06 })
	})

	test("an explicit floor drops sub-floor tails, keeps the rest, never includes OTHER", () => {
		expect(inMapPosterior(pred, { epsilonFloor: 0.05 })).toEqual({ GB: 0.8, FR: 0.06 })
	})

	test("genuine ambiguity above an explicit floor is preserved (the DK↔NO class)", () => {
		const split = { country: "DK", confidence: 0.5, abstained: false, probs: { DK: 0.5, NO: 0.4, OTHER: 0.1 } }
		expect(inMapPosterior(split, { epsilonFloor: 0.05 })).toEqual({ DK: 0.5, NO: 0.4 })
	})

	test("the argmax always survives, even under an extreme floor", () => {
		expect(inMapPosterior(pred, { epsilonFloor: 0.99 })).toEqual({ GB: 0.8 })
	})

	test("abstained / off-map stays null", () => {
		expect(inMapPosterior({ country: null, confidence: 0.2, abstained: true, probs: {} })).toBeNull()
	})
})
