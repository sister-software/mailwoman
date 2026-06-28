/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { buildThresholds, type GBT, gbtScore, trainGBT } from "./gbt.js"

/** Deterministic LCG so the synthetic data + the test are reproducible (no Math.random). */
function lcg(seed: number): () => number {
	let s = seed >>> 0

	return () => {
		s = (s * 1664525 + 1013904223) >>> 0

		return s / 0x100000000
	}
}

/**
 * A non-linearly-separable target: positive IFF x0 XOR x1 — the interaction a linear model can't capture but a depth-2+
 * tree ensemble can. x0/x1 are BINARY (matching the matcher's one-hot agreement-level features, which get clean
 * midpoint splits); x2 is pure continuous noise that carries no signal, so the trees should ignore it.
 */
function makeXor(n: number, seed: number): { X: number[][]; y: number[] } {
	const rnd = lcg(seed)
	const X: number[][] = []
	const y: number[] = []

	for (let i = 0; i < n; i++) {
		const a = rnd() < 0.5 ? 0 : 1
		const b = rnd() < 0.5 ? 0 : 1
		X.push([a, b, rnd()])
		y.push(a !== b ? 1 : 0)
	}

	return { X, y }
}

describe("buildThresholds", () => {
	it("emits midpoints for few-valued features and quantiles for continuous", () => {
		const X = [
			[0, 0.1],
			[1, 0.9],
			[0, 0.5],
			[1, 0.3],
		]
		const thr = buildThresholds(X)
		expect(thr).toHaveLength(2)
		expect(thr[0]).toEqual([0.5]) // binary 0/1 → single midpoint
		expect(thr[1]!.length).toBeGreaterThan(0) // continuous → some split candidates
	})

	it("gives a feature with one unique value no thresholds", () => {
		expect(buildThresholds([[5], [5], [5]])).toEqual([[]])
	})
})

describe("trainGBT / gbtScore", () => {
	it("learns a non-linear (XOR) boundary and separates the classes", () => {
		const { X, y } = makeXor(600, 1)
		const w = y.map(() => 1)
		const model = trainGBT(X, y, w, { rounds: 60, depth: 2, lr: 0.3, minLeaf: 10 })

		// Held-out set from a different seed.
		const { X: Xt, y: yt } = makeXor(400, 99)
		const scores = Xt.map((x) => gbtScore(model, x))
		const posMean = mean(scores.filter((_, i) => yt[i] === 1))
		const negMean = mean(scores.filter((_, i) => yt[i] === 0))
		expect(posMean).toBeGreaterThan(negMean) // positives score higher

		// Thresholding at 0 (the logit midpoint) classifies the held-out set well.
		const correct = Xt.filter((x, i) => (gbtScore(model, x) > 0 ? 1 : 0) === yt[i]).length
		expect(correct / Xt.length).toBeGreaterThan(0.85)
	})

	it("respects class weights — up-weighting the rare positive raises its scores", () => {
		const { X, y } = makeXor(400, 7)
		const flat = trainGBT(
			X,
			y,
			y.map(() => 1),
			{ rounds: 40, depth: 2, lr: 0.3, minLeaf: 10 }
		)
		const up = trainGBT(
			X,
			y,
			y.map((t) => (t === 1 ? 5 : 1)),
			{ rounds: 40, depth: 2, lr: 0.3, minLeaf: 10 }
		)
		const posUpFlat = mean(X.filter((_, i) => y[i] === 1).map((x) => gbtScore(flat, x)))
		const posUpWtd = mean(X.filter((_, i) => y[i] === 1).map((x) => gbtScore(up, x)))
		expect(posUpWtd).toBeGreaterThan(posUpFlat)
	})

	it("round-trips through JSON (the ship-as-a-data-file contract)", () => {
		const { X, y } = makeXor(200, 3)
		const model = trainGBT(
			X,
			y,
			y.map(() => 1),
			{ rounds: 20, depth: 2, lr: 0.3, minLeaf: 10 }
		)
		const reloaded = JSON.parse(JSON.stringify(model)) as GBT

		for (const x of X) expect(gbtScore(reloaded, x)).toBeCloseTo(gbtScore(model, x), 10)
	})
})

function mean(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
}
