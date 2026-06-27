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
 */

/** Seeded `random.Random`-equivalent. Backed by mulberry32 (a 32-bit stateful generator). */
export class SeededRandom {
	#state: number

	constructor(seed: number) {
		// mulberry32 wants a non-zero 32-bit state.
		this.#state = seed >>> 0 || 1
	}

	/** Float in `[0, 1)`. Mirrors Python `random.random()`. */
	random(): number {
		let t = (this.#state += 0x6d2b79f5)
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}

	/** Integer in `[lo, hi]` inclusive. Mirrors Python `random.randint(lo, hi)`. */
	randint(lo: number, hi: number): number {
		return lo + Math.floor(this.random() * (hi - lo + 1))
	}

	/** One uniformly-chosen element. Mirrors Python `random.choice(seq)`. */
	choice<T>(seq: readonly T[]): T {
		return seq[Math.floor(this.random() * seq.length)]!
	}

	/** `k` elements chosen with replacement. Mirrors Python `random.choices(seq, k=k)`. */
	choices<T>(seq: readonly T[], k: number): T[] {
		const out: T[] = []
		for (let i = 0; i < k; i++) out.push(this.choice(seq))
		return out
	}
}
