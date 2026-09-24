/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Seeded random generators and sampling helpers. The Python-shaped API matches helper semantics,
 *   not CPython's MT19937 stream. Existing generators reproduce streams used by corpus data, frozen
 *   evaluations, model splits, and calibration artifacts; do not substitute one for another.
 *   Use `mulberry32` for new code unless an existing stream must be reproduced.
 */

/**
 * Create a Mulberry32 generator returning values in `[0, 1)`.
 * `SeededRandom` uses the same stream.
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
 * Shuffle in place using the supplied bounded-index sampler.
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
 * Shuffle in place using a random-number generator that returns values in `[0, 1)`.
 */
export function shuffleWith<T>(array: T[], random: () => number): void {
	shuffleBy(array, (bound) => Math.floor(random() * bound))
}

/**
 * Choose one element using a generator in `[0, 1)`.
 * Throws for an empty array.
 */
export function sample<T>(array: ReadonlyArray<T>, random: () => number): T {
	if (!array.length) throw new Error("sample: the array is empty, so there is no element to draw")

	return array[Math.floor(random() * array.length)]!
}

/**
 * Multiplier and increment shared by the glibc-style generators below.
 */
const GLIBC_LCG_MULTIPLIER = 1_103_515_245
const GLIBC_LCG_INCREMENT = 12_345

/**
 * Reproduce the float-multiply LCG stream used for conformal calibration.
 *
 * Floating-point rounding makes it different from {@link makeGlibcLcgInt32};
 * keep it for existing artifacts only.
 */
export function makeGlibcLcgFloat64(seed: number): () => number {
	let state = seed

	return () => (state = (state * GLIBC_LCG_MULTIPLIER + GLIBC_LCG_INCREMENT) & 0x7f_ff_ff_ff)
}

/**
 * Reproduce the 32-bit LCG stream used for coarse-placer train/test splits.
 */
export function makeGlibcLcgInt32(seed: number): () => number {
	let state = seed

	return () => (state = (Math.imul(state, GLIBC_LCG_MULTIPLIER) + GLIBC_LCG_INCREMENT) & 0x7f_ff_ff_ff)
}

/**
 * Numerical Recipes LCG used by existing PO-box corpus rows and registry splits.
 *
 * Use `mulberry32` for new code.
 * Seed zero is valid and produces a distinct stream.
 */
export function makeLcg(seed: number): () => number {
	let s = seed >>> 0

	return () => {
		s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296

		return s / 4_294_967_296
	}
}

/**
 * Python-shaped random helper backed by {@link mulberry32}.
 */
export class SeededRandom {
	readonly #next: () => number

	constructor(seed: number) {
		// Replace zero with a non-zero 32-bit seed for Mulberry32.
		this.#next = mulberry32(seed >>> 0 || 1)
	}

	/**
	 * Return a float in `[0, 1)`.
	 */
	random(): number {
		return this.#next()
	}

	/**
	 * Return an integer in the inclusive range `[lo, hi]`.
	 */
	randint(lo: number, hi: number): number {
		return lo + Math.floor(this.random() * (hi - lo + 1))
	}

	/**
	 * Choose one element uniformly.
	 */
	choice<T>(seq: readonly T[]): T {
		return seq[Math.floor(this.random() * seq.length)]!
	}

	/**
	 * Choose `k` elements with replacement.
	 */
	choices<T>(seq: readonly T[], k: number): T[] {
		const out: T[] = []

		for (let i = 0; i < k; i++) {
			out.push(this.choice(seq))
		}

		return out
	}

	/**
	 * Shuffle the array in place.
	 * The output is not bit-identical to CPython's stream.
	 */
	shuffle<T>(arr: T[]): void {
		shuffleWith(arr, () => this.random())
	}

	/**
	 * Return `k` distinct elements without replacement.
	 * The input is unchanged and `k` must not exceed its length.
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
