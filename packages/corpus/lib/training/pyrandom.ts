/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file CPython 3.12's `random.Random`, for the methods the corpus builders draw.
 *
 *   The generator is MT19937 seeded the way CPython seeds it: an integer seed's absolute value becomes the key's
 *   32-bit words, lowest word first, and a string seed is first replaced by the integer whose big-endian bytes
 *   are the string's UTF-8 followed by their SHA-512 digest (CPython's `version=2` seeding). Every method draws its
 *   words in CPython's order, including the rejection loop of `_randbelow`, so equal seeds give equal draws. It
 *   reproduces the recorded sequences `packages/mtf/crates/mtf-sampler/src/pyrandom.rs` reproduces.
 *
 *   Only these methods are implemented: `random`, `getrandbits`, `randrange`, `randint`, `choice`, `choices`,
 *   `shuffle` and `sample` (without `counts`).
 */

import { createHash } from "@mailwoman/core/hash"
import { shuffleBy } from "@mailwoman/core/random"

const N = 624
const M = 397
const MATRIX_A = 0x99_08_b0_df
const UPPER_MASK = 0x80_00_00_00
const LOWER_MASK = 0x7f_ff_ff_ff
const TWO_32 = 4_294_967_296

/**
 * The width of one generator output and of one seed key word.
 */
const WORD_BITS = 32

/**
 * The largest `k` for which CPython's `sample` keeps its base pool-path bound of 21.
 */
const SAMPLE_SMALL_K = 5

/**
 * A seed CPython accepts: an integer of any sign, or a string.
 */
export type PyRandomSeed = number | bigint | string

/**
 * A request CPython would refuse with `ValueError` or `IndexError`.
 */
export class PyRandomDrawError extends Error {
	override name = "PyRandomDrawError"
}

/**
 * The 32-bit words of a non-negative integer, lowest word first; `[0]` for zero.
 */
function keyWords(value: bigint): number[] {
	if (value === 0n) return [0]

	const words: number[] = []

	for (let rest = value; rest > 0n; rest >>= 32n) {
		words.push(Number(rest & 0xff_ff_ff_ffn))
	}

	return words
}

function seedKey(seed: PyRandomSeed): number[] {
	if (typeof seed === "string") {
		const bytes = Buffer.from(seed, "utf8")
		const digest = createHash("sha512").update(bytes).digest()
		const hex = Buffer.concat([bytes, digest]).toString("hex")

		return keyWords(BigInt(`0x${hex}`))
	}

	if (typeof seed === "number" && !Number.isSafeInteger(seed)) {
		throw new PyRandomDrawError(`a numeric seed must be a safe integer, got ${seed}`)
	}

	const integer = BigInt(seed)

	return keyWords(integer < 0n ? -integer : integer)
}

/**
 * The bit length of a positive safe integer, `int.bit_length()`.
 */
function bitLength(n: number): number {
	if (n < TWO_32) return 32 - Math.clz32(n)

	return 64 - Math.clz32(Math.floor(n / TWO_32))
}

/**
 * Options for {@linkcode PyRandom.choices}.
 * At most one of `weights` and `cumWeights` is given.
 */
export interface PyChoicesOptions {
	weights?: readonly number[]
	cumWeights?: readonly number[]
	k?: number
}

/**
 * A CPython-compatible Mersenne Twister, `random.Random(seed)`.
 */
export class PyRandom {
	#mt = new Uint32Array(N)
	#index = N

	constructor(seed: PyRandomSeed) {
		this.#initByArray(seedKey(seed))
	}

	#initGenrand(seed: number): void {
		const mt = this.#mt

		mt[0] = seed

		for (let i = 1; i < N; i++) {
			const previous = mt[i - 1]!

			mt[i] = Math.imul(1_812_433_253, previous ^ (previous >>> 30)) + i
		}

		this.#index = N
	}

	#initByArray(key: readonly number[]): void {
		this.#initGenrand(19_650_218)

		const mt = this.#mt
		let i = 1
		let j = 0

		for (let step = Math.max(N, key.length); step > 0; step--) {
			const previous = mt[i - 1]!

			// oxlint-disable-next-line mailwoman/prefer-home -- MT19937's init_by_array multiplier.
			mt[i] = ((mt[i]! ^ Math.imul(previous ^ (previous >>> 30), 1_664_525)) >>> 0) + key[j]! + j

			i++

			j++

			if (i >= N) {
				mt[0] = mt[N - 1]!
				i = 1
			}

			if (j >= key.length) {
				j = 0
			}
		}

		for (let step = N - 1; step > 0; step--) {
			const previous = mt[i - 1]!

			mt[i] = ((mt[i]! ^ Math.imul(previous ^ (previous >>> 30), 1_566_083_941)) >>> 0) - i

			i++

			if (i >= N) {
				mt[0] = mt[N - 1]!
				i = 1
			}
		}

		mt[0] = 0x80_00_00_00
	}

	#twist(): void {
		const mt = this.#mt

		for (let k = 0; k < N; k++) {
			const y = (mt[k]! & UPPER_MASK) | (mt[(k + 1) % N]! & LOWER_MASK)
			const mag = y & 1 ? MATRIX_A : 0

			mt[k] = mt[(k + M) % N]! ^ (y >>> 1) ^ mag
		}

		this.#index = 0
	}

	/**
	 * The next 32-bit output, `genrand_uint32`.
	 */
	nextUint32(): number {
		if (this.#index >= N) {
			this.#twist()
		}

		let y = this.#mt[this.#index++]!

		y ^= y >>> 11
		y ^= (y << 7) & 0x9d_2c_56_80
		y ^= (y << 15) & 0xef_c6_00_00

		return (y ^ (y >>> 18)) >>> 0
	}

	/**
	 * `random()`: a float in [0, 1) with 53 random bits.
	 */
	random(): number {
		const a = this.nextUint32() >>> 5
		const b = this.nextUint32() >>> 6

		return (a * 67_108_864 + b) * (1 / 9_007_199_254_740_992)
	}

	/**
	 * `getrandbits(k)` for any `k >= 0`.
	 */
	getrandbits(k: number): bigint {
		if (!Number.isInteger(k) || k < 0) throw new PyRandomDrawError("number of bits must be non-negative")

		if (k === 0) return 0n

		if (k <= WORD_BITS) return BigInt(this.nextUint32() >>> (WORD_BITS - k))

		let value = 0n
		let shift = 0n

		for (let remaining = k; remaining > 0; remaining -= WORD_BITS) {
			let word = this.nextUint32()

			if (remaining < WORD_BITS) {
				word >>>= WORD_BITS - remaining
			}

			value |= BigInt(word) << shift
			shift += 32n
		}

		return value
	}

	/**
	 * `getrandbits(k)` for `k <= 53`, as a number.
	 */
	#bitsBelow53(k: number): number {
		if (k <= WORD_BITS) return this.nextUint32() >>> (WORD_BITS - k)

		const low = this.nextUint32()
		const high = this.nextUint32() >>> (64 - k)

		return high * TWO_32 + low
	}

	/**
	 * `_randbelow(n)`: a uniform integer in [0, n), drawn by rejection from `n.bit_length()` bits.
	 *
	 * `n` is a positive safe integer.
	 */
	randbelow(n: number): number {
		if (!Number.isSafeInteger(n) || n <= 0) {
			throw new PyRandomDrawError(`randbelow needs a positive safe integer bound, got ${n}`)
		}

		const k = bitLength(n)
		let r = this.#bitsBelow53(k)

		while (r >= n) {
			r = this.#bitsBelow53(k)
		}

		return r
	}

	/**
	 * `randrange(stop)` or `randrange(start, stop)`, with step 1.
	 */
	randrange(startOrStop: number, stop?: number): number {
		if (typeof stop !== "number") {
			if (startOrStop > 0) return this.randbelow(startOrStop)

			throw new PyRandomDrawError("empty range for randrange()")
		}

		const width = stop - startOrStop

		if (width > 0) return startOrStop + this.randbelow(width)

		throw new PyRandomDrawError(`empty range in randrange(${startOrStop}, ${stop})`)
	}

	/**
	 * `randint(a, b)`, both ends included.
	 */
	randint(a: number, b: number): number {
		return this.randrange(a, b + 1)
	}

	/**
	 * `choice(sequence)`.
	 */
	choice<T>(sequence: ArrayLike<T>): T {
		if (!sequence.length) throw new PyRandomDrawError("Cannot choose from an empty sequence")

		return sequence[this.randbelow(sequence.length)]!
	}

	/**
	 * `shuffle(items)` in place.
	 */
	shuffle<T>(items: T[]): void {
		shuffleBy(items, (bound) => this.randbelow(bound))
	}

	/**
	 * `sample(population, k)`, in pick order, on both of CPython's paths.
	 */
	sample<T>(population: ArrayLike<T>, k: number): T[] {
		const n = population.length

		if (!(k >= 0 && k <= n)) throw new PyRandomDrawError("Sample larger than population or is negative")

		let setsize = 21

		// `4 ** ceil(log(k * 3, 4))`, where CPython's `math.log(x, 4)` is `log(x) / log(4)`.
		if (k > SAMPLE_SMALL_K) {
			setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4))
		}

		const result: T[] = []

		if (n <= setsize) {
			const pool = Array.from(population)

			for (let i = 0; i < k; i++) {
				const j = this.randbelow(n - i)

				result.push(pool[j]!)
				pool[j] = pool[n - i - 1]!
			}

			return result
		}

		const selected = new Set<number>()

		for (let i = 0; i < k; i++) {
			let j = this.randbelow(n)

			while (selected.has(j)) {
				j = this.randbelow(n)
			}

			selected.add(j)
			result.push(population[j]!)
		}

		return result
	}

	/**
	 * `choices(population, weights=…, cum_weights=…, k=…)`.
	 */
	choices<T>(population: ArrayLike<T>, options: PyChoicesOptions = {}): T[] {
		const n = population.length
		const k = options.k ?? 1
		const result: T[] = []

		if (options.weights && options.cumWeights) {
			throw new PyRandomDrawError("Cannot specify both weights and cumulative weights")
		}

		if (!options.cumWeights && !options.weights) {
			for (let i = 0; i < k; i++) {
				result.push(population[Math.floor(this.random() * n)]!)
			}

			return result
		}

		const cumWeights = options.cumWeights ?? accumulate(options.weights!)

		if (cumWeights.length !== n) throw new PyRandomDrawError("The number of weights does not match the population")

		const total = cumWeights[n - 1]!

		if (!(total > 0)) throw new PyRandomDrawError("Total of weights must be greater than zero")

		if (!Number.isFinite(total)) throw new PyRandomDrawError("Total of weights must be finite")

		const hi = n - 1

		for (let i = 0; i < k; i++) {
			const x = this.random() * total
			// `bisect_right(cum_weights, x, 0, hi)`.
			let lo = 0
			let top = hi

			while (lo < top) {
				const mid = (lo + top) >>> 1

				if (x < cumWeights[mid]!) {
					top = mid
				} else {
					lo = mid + 1
				}
			}

			result.push(population[lo]!)
		}

		return result
	}
}

/**
 * The prefix sums of `weights`, left to right, as `itertools.accumulate` produces them.
 */
export function accumulate(weights: readonly number[]): number[] {
	let sum = 0

	return weights.map((weight) => (sum += weight))
}
