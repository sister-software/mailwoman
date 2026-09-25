/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

const MAX_EXACT_SPLIT_VALUES = 5

const QUANTILE_SPLIT_COUNT = 6

/**
 * A trained tree: an internal split (feature `f` ≤ `thr` → `lo`, else `hi`) or a `leaf` value.
 */
export type TreeNode = { leaf: number } | { f: number; thr: number; lo: TreeNode; hi: TreeNode }

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))

/**
 * Returns each feature's candidate split thresholds: midpoints between values for
 * features with at most five distinct values, and six quantiles otherwise.
 */
export function buildThresholds(X: number[][]): number[][] {
	const dim = X[0]?.length ?? 0
	const out: number[][] = []

	for (let f = 0; f < dim; f++) {
		const vals = X.map((r) => r[f]!)
		const uniq = [...new Set(vals)].toSorted((p, q) => p - q)

		if (uniq.length <= 1) {
			out.push([])
		} else if (uniq.length <= MAX_EXACT_SPLIT_VALUES) {
			const t: number[] = []

			for (let k = 0; k < uniq.length - 1; k++) {
				t.push((uniq[k]! + uniq[k + 1]!) / 2)
			}

			out.push(t)
		} else {
			const sorted = [...vals].toSorted((p, q) => p - q)
			const t: number[] = []

			for (let q = 1; q <= QUANTILE_SPLIT_COUNT; q++) {
				t.push(sorted[Math.floor((q / 7) * (sorted.length - 1))]!)
			}

			out.push([...new Set(t)])
		}
	}

	return out
}

function nodeSSE(rows: number[], g: number[], w: number[]): number {
	let wsum = 0
	let wg = 0

	for (const i of rows) {
		wsum += w[i]!
		wg += w[i]! * g[i]!
	}

	const mean = wsum > 0 ? wg / wsum : 0
	let sse = 0

	for (const i of rows) {
		const d = g[i]! - mean
		sse += w[i]! * d * d
	}

	return sse
}

function fitRegTree(
	rows: number[],
	X: number[][],
	g: number[],
	w: number[],
	thresholds: number[][],
	depth: number,
	minLeaf: number
): TreeNode {
	let wsum = 0
	let wg = 0

	for (const i of rows) {
		wsum += w[i]!
		wg += w[i]! * g[i]!
	}

	const leaf = wsum > 0 ? wg / wsum : 0

	if (depth === 0 || rows.length < 2 * minLeaf) return { leaf }
	const parentSSE = nodeSSE(rows, g, w)
	let bestGain = 1e-12
	let bestF = -1
	let bestThr = 0
	let bestLo: number[] = []
	let bestHi: number[] = []

	for (let f = 0; f < thresholds.length; f++) {
		for (const thr of thresholds[f]!) {
			const lo: number[] = []
			const hi: number[] = []

			for (const i of rows) {
				;(X[i]![f]! <= thr ? lo : hi).push(i)
			}

			if (lo.length < minLeaf || hi.length < minLeaf) continue
			const gain = parentSSE - (nodeSSE(lo, g, w) + nodeSSE(hi, g, w))

			if (gain > bestGain) {
				bestGain = gain
				bestF = f
				bestThr = thr
				bestLo = lo
				bestHi = hi
			}
		}
	}

	if (bestF < 0) return { leaf }

	return {
		f: bestF,
		thr: bestThr,
		lo: fitRegTree(bestLo, X, g, w, thresholds, depth - 1, minLeaf),
		hi: fitRegTree(bestHi, X, g, w, thresholds, depth - 1, minLeaf),
	}
}

function predictTree(t: TreeNode, x: number[]): number {
	let n = t

	while ("f" in n) {
		n = x[n.f]! <= n.thr ? n.lo : n.hi
	}

	return n.leaf
}

/**
 * A trained gradient-boosted tree ensemble whose trees add to a base log-odds, stored as plain JSON.
 */
export interface GBT {
	trees: TreeNode[]
	lr: number
	base: number
}

/**
 * Hyperparameters for {@link trainGBT}.
 */
export interface GBTOpts {
	rounds: number
	depth: number
	lr: number
	minLeaf: number
}

/**
 * Gradient-boosted regression trees on logistic loss, with per-sample class weights `w`.
 */
export function trainGBT(X: number[][], y: number[], w: number[], opts: GBTOpts): GBT {
	const N = X.length
	const thresholds = buildThresholds(X)
	const rowsAll = Array.from({ length: N }, (_, i) => i)
	let wpos = 0
	let wtot = 0

	for (let i = 0; i < N; i++) {
		wtot += w[i]!

		if (y[i] === 1) {
			wpos += w[i]!
		}
	}

	const base = Math.log((wpos + 1) / (wtot - wpos + 1))
	const F = new Array<number>(N).fill(base)
	const trees: TreeNode[] = []

	for (let m = 0; m < opts.rounds; m++) {
		const g = new Array<number>(N)

		for (let i = 0; i < N; i++) {
			g[i] = y[i]! - sigmoid(F[i]!)
		}

		const tree = fitRegTree(rowsAll, X, g, w, thresholds, opts.depth, opts.minLeaf)

		for (let i = 0; i < N; i++) {
			F[i]! += opts.lr * predictTree(tree, X[i]!)
		}

		trees.push(tree)
	}

	return { trees, lr: opts.lr, base }
}

/**
 * Returns the model's logit for one feature vector, which is compared against a
 * threshold the same way as a Fellegi-Sunter match weight.
 */
export function gbtScore(m: GBT, x: number[]): number {
	let f = m.base

	for (const t of m.trees) {
		f += m.lr * predictTree(t, x)
	}

	return f
}
