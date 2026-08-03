/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A tiny seeded PRNG shaped like Python's `random.Random` (the `random()` / `randint()` /
 *   `choice()` / `choices()` surface the `scripts/extract-tuples*.py` originals used). Lives here
 *   so the two ported extractors share one implementation.
 *
 *   NOTE — this is deliberately NOT a bit-exact port of CPython's MT19937. The source scripts draw
 *   their rows with SQL `ORDER BY RANDOM()` (already non-deterministic across runs) and the
 *   postcodes are synthetic shape-data ("the model learns the SHAPE, not the exact mapping"), so a
 *   byte-identical random stream buys nothing observable. What is preserved is what matters: a
 *   seeded, deterministic-per-input stream and Python's helper semantics — inclusive `randint`,
 *   uniform `choice`, with-replacement `choices`.
 *
 *   TWO generators live here, and that is deliberate: their streams differ, and both streams are
 *   baked into shipped artifacts. mulberry32 decides which typos get injected into the training
 *   corpus; the LCG decides the train/test splits the scorer evals report. Collapsing them onto one
 *   would silently rewrite synthesized corpus rows and published eval numbers. New code should reach
 *   for `mulberry32` (better distribution) unless it must reproduce an existing stream.
 */

/**
 * Mulberry32 as a thunk — `seed` in, `() => number` in `[0, 1)` out.
 *
 * The thunk exists because callers inject a `random` option and want a bare function; `SeededRandom` below is the same
 * generator behind the Python-shaped class surface. Reach for whichever matches the call site — for one seed they
 * produce identical streams.
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
 * The Numerical-Recipes linear congruential generator — `s = s * 1664525 + 1013904223 mod 2³²`.
 *
 * Weaker than {@link mulberry32}, and kept only because its exact stream is baked into shipped artifacts: the synthetic
 * PO-box adapter's rows and the registry scorers' train/test splits both reproduce from it. Prefer `mulberry32` for
 * anything new.
 *
 * Seed 0 is a valid state here (unlike mulberry32, which needs a non-zero one); callers that used to guard with `seed
 * || 1` keep doing so at the call site, since dropping the guard would shift their stream for that one seed.
 */
export function makeLcg(seed: number): () => number {
	let s = seed >>> 0

	return () => {
		s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296

		return s / 4_294_967_296
	}
}

/**
 * Seeded `random.Random`-equivalent. Backed by {@link mulberry32}.
 */
export class SeededRandom {
	readonly #next: () => number

	constructor(seed: number) {
		// mulberry32 wants a non-zero 32-bit state.
		this.#next = mulberry32(seed >>> 0 || 1)
	}

	/**
	 * Float in `[0, 1)`. Mirrors Python `random.random()`.
	 */
	random(): number {
		return this.#next()
	}

	/**
	 * Integer in `[lo, hi]` inclusive. Mirrors Python `random.randint(lo, hi)`.
	 */
	randint(lo: number, hi: number): number {
		return lo + Math.floor(this.random() * (hi - lo + 1))
	}

	/**
	 * One uniformly-chosen element. Mirrors Python `random.choice(seq)`.
	 */
	choice<T>(seq: readonly T[]): T {
		return seq[Math.floor(this.random() * seq.length)]!
	}

	/**
	 * `k` elements chosen with replacement. Mirrors Python `random.choices(seq, k=k)`.
	 */
	choices<T>(seq: readonly T[], k: number): T[] {
		const out: T[] = []

		for (let i = 0; i < k; i++) {
			out.push(this.choice(seq))
		}

		return out
	}

	/**
	 * In-place Fisher-Yates shuffle. Mirrors Python `random.shuffle(x)` — distribution-correct, but NOT bit-identical to
	 * CPython's `_randbelow` stream (see the module header on the seeded-but-not- MT19937 tradeoff).
	 */
	shuffle<T>(arr: T[]): void {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = this.randint(0, i)
			const tmp = arr[i]!
			arr[i] = arr[j]!
			arr[j] = tmp
		}
	}

	/**
	 * `k` distinct elements without replacement, as a NEW array. Mirrors Python `random.sample(seq, k)` semantics
	 * (uniform, no mutation of the input); the selection ORDER is partial-Fisher-Yates, which — like {@link shuffle} — is
	 * uniform but not CPython-bit-identical. `k` must be `<= seq.length`.
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
