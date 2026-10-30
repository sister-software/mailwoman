/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Seeded random generators and sampling helpers.
 *
 *   Each LCG reproduces the stream behind existing corpus data, evaluations, model splits or calibration artifacts.
 *   A different generator changes those outputs. New code should use `mulberry32`.
 */

import { hashFNV1a } from "#coarse-placer/fnv-hash"

/**
 * Creates a Mulberry32 generator that returns values in `[0, 1)`.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0

	return () => {
		a = (a + 0x6d_2b_79_f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
	}
}

/**
 * Shuffles an array in place with Fisher-Yates.
 * `pick(bound)` must return an integer in `[0, bound)`.
 */
export function shuffleBy<T>(array: T[], pick: (bound: number) => number): void {
	for (let i = array.length - 1; i > 0; i--) {
		const j = pick(i + 1)
		const swapped = array[i]!

		array[i] = array[j]!
		array[j] = swapped
	}
}

/**
 * Shuffles an array in place with a generator that returns values in `[0, 1)`.
 */
export function shuffleWith<T>(array: T[], random: () => number): void {
	shuffleBy(array, (bound) => Math.floor(random() * bound))
}

/**
 * Picks one element with a generator that returns values in `[0, 1)`.
 *
 * @throws When the array is empty.
 */
export function sample<T>(array: ReadonlyArray<T>, random: () => number): T {
	if (!array.length) throw new Error("sample: the array is empty, so there is no element to draw")

	return array[Math.floor(random() * array.length)]!
}

/**
 * The glibc LCG multiplier and increment.
 */
const GLIBC_LCG_MULTIPLIER = 1_103_515_245
const GLIBC_LCG_INCREMENT = 12_345

/**
 * Reproduces the float-multiply glibc LCG stream used for conformal calibration.
 *
 * Floating-point rounding makes this stream differ from {@link makeGlibcLcgInt32}.
 */
export function makeGlibcLcgFloat64(seed: number): () => number {
	let state = seed

	return () => (state = (state * GLIBC_LCG_MULTIPLIER + GLIBC_LCG_INCREMENT) & 0x7f_ff_ff_ff)
}

/**
 * Reproduces the 32-bit integer glibc LCG stream used for coarse-placer train and test splits.
 */
export function makeGlibcLcgInt32(seed: number): () => number {
	let state = seed

	return () => (state = (Math.imul(state, GLIBC_LCG_MULTIPLIER) + GLIBC_LCG_INCREMENT) & 0x7f_ff_ff_ff)
}

/**
 * Reproduces the Numerical Recipes LCG stream used for PO-box corpus rows and registry splits.
 * It returns values in `[0, 1)`, and seed zero is valid.
 */
export function makeLcg(seed: number): () => number {
	let s = seed >>> 0

	return () => {
		s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296

		return s / 4_294_967_296
	}
}

/**
 * A seeded generator with Python `random`-style methods, backed by {@link mulberry32}.
 *
 * The method semantics follow Python.
 * The streams differ from CPython's.
 */
export class SeededRandom {
	readonly #next: () => number

	/**
	 * A string seed is reduced to 32 bits by FNV-1a over its UTF-16 code units,
	 * so `"${seed}-postcode"` and a numeric seed both name a stream.
	 */
	constructor(seed: number | string) {
		// Seed zero maps to one.
		this.#next = mulberry32((typeof seed === "string" ? hashFNV1a(seed) : seed) >>> 0 || 1)
	}

	/**
	 * Returns a float in `[0, 1)`.
	 */
	random(): number {
		return this.#next()
	}

	/**
	 * Returns an integer in the inclusive range `[lo, hi]`.
	 */
	randint(lo: number, hi: number): number {
		return lo + Math.floor(this.random() * (hi - lo + 1))
	}

	/**
	 * Returns an integer in `[0, stop)`, or in `[start, stop)` given both.
	 *
	 * @throws When the range is empty.
	 */
	randrange(startOrStop: number, stop?: number): number {
		const [start, end] = stop === undefined ? [0, startOrStop] : [startOrStop, stop]

		if (end <= start) throw new RangeError(`randrange: the range [${start}, ${end}) is empty`)

		return this.randint(start, end - 1)
	}

	/**
	 * Picks one element uniformly.
	 *
	 * @throws When the sequence is empty.
	 */
	choice<T>(seq: readonly T[]): T {
		if (!seq.length) throw new RangeError("choice: the sequence is empty")

		return seq[Math.floor(this.random() * seq.length)]!
	}

	/**
	 * Picks one element with probability proportional to its weight.
	 *
	 * @throws When the lengths differ or no weight is positive.
	 */
	weightedChoice<T>(seq: readonly T[], weights: readonly number[]): T {
		if (seq.length !== weights.length) throw new RangeError("weightedChoice: the weights do not match the sequence")

		const total = weights.reduce((sum, weight) => sum + weight, 0)

		if (!(total > 0)) throw new RangeError("weightedChoice: no weight is positive")

		let target = this.random() * total

		for (const [index, weight] of weights.entries()) {
			target -= weight

			if (target < 0) return seq[index]!
		}

		return seq.at(-1)!
	}

	/**
	 * Picks `k` elements with replacement.
	 */
	choices<T>(seq: readonly T[], k: number): T[] {
		const out: T[] = []

		for (let i = 0; i < k; i++) {
			out.push(this.choice(seq))
		}

		return out
	}

	/**
	 * Shuffles the array in place.
	 */
	shuffle<T>(arr: T[]): void {
		shuffleWith(arr, () => this.random())
	}

	/**
	 * Returns `k` distinct elements without replacement and leaves the input unchanged.
	 * `k` must be at most the input length.
	 */
	sample<T>(seq: readonly T[], k: number): T[] {
		const pool = seq.slice()
		const n = pool.length
		const out: T[] = []

		for (let i = 0; i < k; i++) {
			const j = this.randint(i, n - 1)
			const tmp = pool[i]!
			pool[i] = pool[j]!
			pool[j] = tmp
			out.push(pool[i]!)
		}

		return out
	}
}
