/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coarse-placer (#244) loader + int8 round-trip. Builds a tiny synthetic artifact on disk (no
 *   /mnt/playpen dependency) so `CoarsePlacer.fromArtifactDir` is exercised end-to-end for both the
 *   fp32 and the int8-per-row formats, and asserts the int8 path predicts the same class with near-
 *   identical confidence. Also covers `featurize` determinism and `dequantizeInt8Weights`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"

import { CoarsePlacer, dequantizeInt8Weights, FEATURE_DIM, featurize } from "./coarse-placer.js"

const tmpRoot = mkdtempSync(join(tmpdir(), "coarse-placer-test-"))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

/** Deterministic pseudo-random weights in [-0.05, 0.05], LCG-seeded so the test is reproducible. */
function seededWeights(classCount: number, dim: number, seed: number): Float32Array {
	const w = new Float32Array(classCount * dim)
	let s = seed >>> 0
	for (let i = 0; i < w.length; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		w[i] = (s / 0xffffffff - 0.5) * 0.1
	}
	return w
}

/** Per-row symmetric int8 quantization (mirrors scripts/coarse-placer/quantize.mjs). */
function quantize(w: Float32Array, classCount: number, dim: number) {
	const int8 = new Int8Array(classCount * dim)
	const scales: number[] = []
	for (let c = 0; c < classCount; c++) {
		const base = c * dim
		let maxAbs = 0
		for (let i = 0; i < dim; i++) maxAbs = Math.max(maxAbs, Math.abs(w[base + i]!))
		const scale = maxAbs / 127 || 1
		scales.push(scale)
		for (let i = 0; i < dim; i++) int8[base + i] = Math.max(-127, Math.min(127, Math.round(w[base + i]! / scale)))
	}
	return { int8, scales }
}

/** Write an fp32 and an int8 artifact dir for the same weights; return both paths. */
function writeArtifacts(classes: string[], dim: number, weights: Float32Array, bias: number[], temperature = 1) {
	const fp32Dir = join(tmpRoot, `fp32-${classes.join("")}-${dim}`)
	const int8Dir = join(tmpRoot, `int8-${classes.join("")}-${dim}`)
	mkdirSync(fp32Dir, { recursive: true })
	mkdirSync(int8Dir, { recursive: true })

	const baseMeta = { classes, featureDim: dim, temperature, bias }
	writeFileSync(join(fp32Dir, "meta.json"), JSON.stringify(baseMeta))
	writeFileSync(join(fp32Dir, "weights.bin"), Buffer.from(weights.buffer, weights.byteOffset, weights.byteLength))

	const { int8, scales } = quantize(weights, classes.length, dim)
	writeFileSync(join(int8Dir, "meta.json"), JSON.stringify({ ...baseMeta, quantization: "int8-per-row", scales }))
	writeFileSync(join(int8Dir, "weights.bin"), Buffer.from(int8.buffer))
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
		// Script-presence tokens differ, so the sets are not equal.
		expect([...cyrillic].some((i) => !latin.has(i))).toBe(true)
	})
})

describe("dequantizeInt8Weights", () => {
	test("reconstructs W = int8 * scale per row", () => {
		const int8 = Int8Array.from([127, -127, 0, 64, 10, -10, 100, -50])
		const scales = [0.01, 0.5]
		const out = dequantizeInt8Weights(int8, scales, 2, 4)
		// Float32 storage, so compare with tolerance (1.27 round-trips to 1.26999998…).
		for (const [i, want] of [1.27, -1.27, 0, 0.64].entries()) expect(out[i]).toBeCloseTo(want, 6)
		expect(out[4]).toBeCloseTo(5, 6)
		expect(out[7]).toBeCloseTo(-25, 6)
	})

	test("rejects length / scale-count mismatch", () => {
		expect(() => dequantizeInt8Weights(new Int8Array(8), [1], 2, 4)).toThrow()
		expect(() => dequantizeInt8Weights(new Int8Array(7), [1, 1], 2, 4)).toThrow()
	})
})

describe("CoarsePlacer.fromArtifactDir", () => {
	const classes = ["AA", "BB", "CC"]
	const bias = [0.1, -0.2, 0.05]
	const weights = seededWeights(classes.length, FEATURE_DIM, 12345)
	const { fp32Dir, int8Dir } = writeArtifacts(classes, FEATURE_DIM, weights, bias)
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
		const badDir = join(tmpRoot, "int8-noscales")
		mkdirSync(badDir, { recursive: true })
		writeFileSync(
			join(badDir, "meta.json"),
			JSON.stringify({ classes, featureDim: FEATURE_DIM, temperature: 1, bias, quantization: "int8-per-row" })
		)
		writeFileSync(join(badDir, "weights.bin"), Buffer.from(new Int8Array(classes.length * FEATURE_DIM).buffer))
		await expect(CoarsePlacer.fromArtifactDir(badDir)).rejects.toThrow(/scales/)
	})
})

describe("open-set reject rule (#244 M2)", () => {
	// Zero weights ⇒ logits == bias ⇒ probs == softmax(bias), independent of the input string. Lets us
	// engineer an exact class distribution and assert the reject/route decoupling deterministically.
	const classes = ["US", "FR", "OTHER"]
	// dim MUST be FEATURE_DIM: featurize() returns hashed indices in [0, FEATURE_DIM); a smaller dim
	// would index past the (zero) weight rows → NaN logits. Zero weights ⇒ logits == bias regardless.
	const dim = FEATURE_DIM
	const make = (bias: number[], opts: { abstainBelow?: number; openSet?: boolean }) =>
		new CoarsePlacer(
			{ classes, featureDim: dim, temperature: 1, bias, weights: new Float32Array(classes.length * dim) },
			opts
		)

	test("keeps an in-map-but-country-ambiguous address the max-prob rule rejects", () => {
		// US .4 / FR .4 / OTHER .2 — max-prob 0.4 < 0.5 (reject), but in-map MASS 0.8 ≥ 0.5 (keep).
		const bias = [Math.log(0.4), Math.log(0.4), Math.log(0.2)]
		const def = make(bias, { abstainBelow: 0.5 })
		const open = make(bias, { abstainBelow: 0.5, openSet: true })

		const d = def.predict("x")
		expect(d.abstained).toBe(true)
		expect(d.country).toBeNull()

		const o = open.predict("x")
		expect(o.abstained).toBe(false)
		expect(o.country).toBe("US") // argmax over the in-map classes
		expect(o.confidence).toBeCloseTo(0.4, 5) // routed country's marginal (the posterior weight)
	})

	test("rejects to null (never 'OTHER' as a country) when off-map mass dominates", () => {
		const bias = [Math.log(0.1), Math.log(0.1), Math.log(0.8)] // OTHER .8
		const def = make(bias, { abstainBelow: 0.5 })
		const open = make(bias, { abstainBelow: 0.5, openSet: true })

		// Default rule: OTHER wins outright (0.8 ≥ 0.5) → a confident OTHER, not an abstain.
		expect(def.predict("x").country).toBe("OTHER")
		// Open-set: in-map mass 0.2 < 0.5 → abstain; a reject is null, never the OTHER class.
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
		// All-zero weights → logits are the (equal) bias → near-uniform softmax → top prob ≈ 1/C < 0.5.
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
