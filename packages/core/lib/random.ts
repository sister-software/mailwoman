/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A tiny seeded PRNG shaped like Python's `random.Random` (the `random()` / `randint()` /
 *   `choice()` / `choices()` surface the `scripts/extract-tuples*.py` originals used). Lives here
 *   so the two ported extractors share one implementation.
 *
 *   NOTE — this is deliberately not a bit-exact port of CPython's MT19937. The source scripts draw
 *   their rows with SQL `ORDER BY RANDOM()` (already non-deterministic across runs) and the
 *   postcodes are synthetic shape-data ("the model learns the SHAPE, not the exact mapping"), so a
 *   byte-identical random stream adds nothing observable. What is preserved is what matters: a
 *   seeded, deterministic-per-input stream and Python's helper semantics — inclusive `randint`,
 *   uniform `choice`, with-replacement `choices`.
 *
 *   Four generators live here, and that is deliberate: no two produce the same sequence, and each is
 *   baked into an artifact that shipped. mulberry32 decides which typos get injected into the
 *   training corpus and which rows the frozen eval panels draw; `makeLcg` decides the registry
 *   scorers' train/test splits; the two glibc-constant generators decide the coarse-placer's split
 *   and the conformal calibration split. Collapsing any onto another would silently rewrite
 *   synthesized corpus rows, a frozen panel, or a published number. New code should reach for
 *   `mulberry32` (better distribution) unless it must reproduce an existing stream.
 *
 *   The two glibc generators are the trap: same constants, different multiply, different sequence.
 *   They were typed out in two files that each called theirs "the glibc LCG", which is how a reader
 *   comes to believe they are interchangeable. They are not — see `makeGlibcLcgFloat64`.
 *
 *   `shuffleBy` is the other half of the split. What a call site may be unable to change is its
 *   SAMPLER — the stream, and how an index is drawn from it. The WALK is the same everywhere, so it
 *   is written once and takes `pick(bound)`; `shuffleWith` is the common sampler over it.
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
 * In-place Fisher-Yates over `array`, taking the SAMPLER as a parameter: `pick(bound)` returns an index in `[0,
 * bound)`.
 *
 * The walk is "swap `i` with a uniform index in `[0, i]`, counting down". How that index is drawn is the sampler, and
 * the samplers here differ because each reproduces a stream baked into an artifact — the coarse-placer's train/test
 * split, the conformal calibration split, a frozen eval panel. Parameterizing the sampler rather than the generator is
 * what lets all of them share one walk; CPython's `random.shuffle` takes `randbelow` for the same reason.
 *
 * Prefer {@link shuffleWith} unless the call site derives its index some way other than scaling a float.
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
 * In-place Fisher-Yates over `array`, drawing from a generator of floats in `[0, 1)`.
 *
 * The common case: `pick` is `Math.floor(random() * bound)`. A call site whose sampler is not that shape — taking a raw
 * generator state modulo `bound`, say — reaches for {@link shuffleBy} instead, and gets the same walk.
 */
export function shuffleWith<T>(array: T[], random: () => number): void {
	shuffleBy(array, (bound) => Math.floor(random() * bound))
}

/**
 * One element of `array`, drawn with the supplied unit-interval source — the single-draw companion to
 * {@link shuffleWith}, taking the same `() => number` shape so a caller threads one generator through both.
 *
 * {@link SeededRandom.choice} answers the same question for a caller holding the generator as an object. This free
 * function is for the ones threading a thunk, which is most of the corpus synthesizers.
 *
 * Raises on an empty array rather than answering `undefined`: a sampler that returns nothing has no element to report,
 * and a caller that reads that as a value writes it into a row.
 */
export function sample<T>(array: ReadonlyArray<T>, random: () => number): T {
	if (!array.length) throw new Error("sample: the array is empty, so there is no element to draw")

	return array[Math.floor(random() * array.length)]!
}

/**
 * The multiplier and increment glibc's `rand()` uses. Two generators below share them and are not the same stream, so
 * the constants live here once rather than being re-typed beside each.
 */
const GLIBC_LCG_MULTIPLIER = 1_103_515_245
const GLIBC_LCG_INCREMENT = 12_345

/**
 * Glibc's LCG constants stepped with a FLOAT64 multiply, returning the raw 31-bit state.
 *
 * The float multiply is the point, and it is not a rounding detail: the state reaches 2³¹ and the product with the
 * multiplier is about 2.3 × 10¹⁸, past 2⁵³ where a double stops being exact. So this produces a different sequence from
 * {@link makeGlibcLcgInt32} despite the identical constants. Measured over every seed from 1 to 2,000,000, the draw the
 * two first disagree on is the 2nd for 1,963,788 seeds, the 3rd for 35,967, the 4th for 242 and the 5th for 3 — never
 * the 1st, because a seed under 2⁵³/1103515245 = 8,162,279 keeps that first product exact. Above it they part on the
 * first draw, which is where this file's own caller sits: the conformal seed mixes to 192,663,848.
 *
 * So a reader comparing one draw, or a few from a small seed, can conclude these are the same generator. They are not,
 * and neither is substitutable for the other.
 *
 * Kept because the published conformal thresholds were selected under this one. Prefer {@link mulberry32} for anything
 * new; this exists to reproduce an artifact, not to generate numbers well.
 */
export function makeGlibcLcgFloat64(seed: number): () => number {
	let state = seed

	return () => (state = (state * GLIBC_LCG_MULTIPLIER + GLIBC_LCG_INCREMENT) & 0x7f_ff_ff_ff)
}

/**
 * Glibc's LCG constants stepped with `Math.imul`, a 32-bit wrapping multiply, returning the raw 31-bit state.
 *
 * The coarse-placer's train/test split reproduces from this one, so every shipped coarse-placer model was trained on
 * the order it produces. See {@link makeGlibcLcgFloat64} for why the two are different streams.
 */
export function makeGlibcLcgInt32(seed: number): () => number {
	let state = seed

	return () => (state = (Math.imul(state, GLIBC_LCG_MULTIPLIER) + GLIBC_LCG_INCREMENT) & 0x7f_ff_ff_ff)
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
	 * In-place Fisher-Yates shuffle. Mirrors Python `random.shuffle(x)` — distribution-correct, but not bit-identical to
	 * CPython's `_randbelow` stream (see the module header on the seeded-but-not- MT19937 tradeoff).
	 */
	shuffle<T>(arr: T[]): void {
		shuffleWith(arr, () => this.random())
	}

	/**
	 * `k` distinct elements without replacement, as a new array. Mirrors Python `random.sample(seq, k)` semantics
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
