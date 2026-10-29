/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The NumPy operations the isotonic calibration fit was written in, reproduced to the bit.
 *
 *   A calibration table and its report are compared with the ones NumPy wrote, so each operation here performs the
 *   floating-point steps NumPy's performs, in its order. A sum is NumPy's pairwise sum, a mean that sum over the count,
 *   and an interpolation `np.interp`'s formula over the index its binary search returns.
 */

/**
 * The block NumPy's pairwise sum adds without splitting: `PW_BLOCKSIZE` in `loops_utils.h.src`.
 */
const PAIRWISE_BLOCK = 128

/**
 * The unrolled accumulators of NumPy's pairwise sum.
 */
const UNROLL = 8

/**
 * `np.add.reduce` over a contiguous float64 array: NumPy's pairwise summation.
 */
export function pairwiseSum(values: ArrayLike<number>, start = 0, length = values.length - start): number {
	if (length < UNROLL) {
		let sum = 0

		for (let i = 0; i < length; i++) {
			sum += values[start + i]!
		}

		return sum
	}

	if (length <= PAIRWISE_BLOCK) {
		const r = Array.from({ length: UNROLL }, (_, j) => values[start + j]!)
		let i = UNROLL

		for (; i < length - (length % UNROLL); i += UNROLL) {
			for (let j = 0; j < UNROLL; j++) {
				r[j]! += values[start + i + j]!
			}
		}

		let sum = r[0]! + r[1]! + (r[2]! + r[3]!) + (r[4]! + r[5]! + (r[6]! + r[7]!))

		for (; i < length; i++) {
			sum += values[start + i]!
		}

		return sum
	}

	let half = Math.floor(length / 2)

	half -= half % UNROLL

	return pairwiseSum(values, start, half) + pairwiseSum(values, start + half, length - half)
}

/**
 * `np.mean` of a float64 array: the pairwise sum over the count.
 */
export function numpyMean(values: ArrayLike<number>): number {
	return pairwiseSum(values) / values.length
}

/**
 * `np.linspace(start, stop, num)` with its endpoint: `i * step + start`, and the last value `stop` exactly.
 */
export function numpyLinspace(start: number, stop: number, num: number): number[] {
	const step = (stop - start) / (num - 1)
	const out = Array.from({ length: num }, (_, i) => i * step + start)

	out[num - 1] = stop

	return out
}

/**
 * The largest index `j` with `xs[j] <= x` in ascending `xs`, or -1:
 * the index `np.interp`'s binary search returns.
 */
function floorIndex(xs: ArrayLike<number>, x: number): number {
	let low = 0
	let high = xs.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if (x >= xs[middle]!) {
			low = middle + 1
		} else {
			high = middle
		}
	}

	return low - 1
}

/**
 * `np.interp(x, xs, ys)` for one value: clamped outside the range, `ys[j]` on an
 * exact match, and otherwise `slope * (x - xs[j]) + ys[j]`.
 */
export function numpyInterp(x: number, xs: ArrayLike<number>, ys: ArrayLike<number>): number {
	const last = xs.length - 1

	if (x > xs[last]!) return ys[last]!

	if (x < xs[0]!) return ys[0]!

	const j = floorIndex(xs, x)

	if (j === last || xs[j] === x) return ys[j]!

	const slope = (ys[j + 1]! - ys[j]!) / (xs[j + 1]! - xs[j]!)
	const value = slope * (x - xs[j]!) + ys[j]!

	if (!Number.isNaN(value)) return value

	const retry = slope * (x - xs[j + 1]!) + ys[j + 1]!

	return Number.isNaN(retry) && ys[j] === ys[j + 1] ? ys[j]! : retry
}

/**
 * The indexes that sort `values` ascending, equal values in their original
 * order: `np.argsort(kind="mergesort")`.
 */
export function stableArgsort(values: ArrayLike<number>): number[] {
	return Array.from({ length: values.length }, (_, i) => i).toSorted((a, b) => values[a]! - values[b]! || a - b)
}
