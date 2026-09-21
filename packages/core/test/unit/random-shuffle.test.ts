/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `shuffleWith` replaced four re-typed Fisher-Yates walks, three of which decide bytes that have shipped: the
 *   frozen eval panel's rows, the fr-lieudit corpus recipe's rows, and the coarse-placer's train/test split.
 *   So the property under test is not that it shuffles. It is that it draws in exactly the order each of
 *   those loops drew, because a changed order silently rewrites an artifact nobody re-reads.
 *
 *   The fourth, in `conformal-calibrate.run.ts`, takes a raw LCG state modulo `i + 1` rather than
 *   `floor(random() * (i + 1))`. That is the same walk with a different sampler, so it goes through `shuffleBy`;
 *   the last case asserts both halves — that `shuffleBy` reproduces it, and that `shuffleWith` does not.
 */

import {
	makeGlibcLcgFloat64,
	makeGlibcLcgInt32,
	mulberry32,
	SeededRandom,
	shuffleBy,
	shuffleWith,
} from "@mailwoman/core/random"
import { describe, expect, it } from "vitest"

/**
 * The walk as `panel-fill`, `fr-lieudit` and the coarse-placer trainer each spelled it out.
 */
function retypedWalk<T>(array: T[], random: () => number): void {
	// oxlint-disable-next-line mailwoman/prefer-home -- this is the copy under test: the walk the call sites used to spell out, kept here so the equivalence is asserted rather than assumed.
	for (let index = array.length - 1; index > 0; index--) {
		const swap = Math.floor(random() * (index + 1))

		;[array[index], array[swap]] = [array[swap]!, array[index]!]
	}
}

/**
 * The sizes the collapsed call sites run at, including 10,932 — the frozen
 * same-data panel's own eligible-pool size.
 */
const SIZES = [2, 24, 1000, 10_932]
const SEEDS = [1, 7, 20_260_913, 4_294_967_295]

describe("shuffleWith", () => {
	it("draws in the order the re-typed walks drew, at every size and seed they run at", () => {
		for (const size of SIZES) {
			for (const seed of SEEDS) {
				const items = Array.from({ length: size }, (_, index) => index)
				const shared = [...items]
				const retyped = [...items]

				shuffleWith(shared, mulberry32(seed))
				retypedWalk(retyped, mulberry32(seed))

				expect(shared).toStrictEqual(retyped)
			}
		}
	})

	it("leaves SeededRandom.shuffle drawing exactly as it did", () => {
		for (const size of SIZES) {
			for (const seed of SEEDS) {
				const items = Array.from({ length: size }, (_, index) => index)
				const viaClass = [...items]
				const viaFunction = [...items]

				new SeededRandom(seed).shuffle(viaClass)
				// SeededRandom seeds mulberry32 with `seed >>> 0 || 1`, and randint(0, i) expands to the same floor form.
				shuffleWith(viaFunction, mulberry32(seed >>> 0 || 1))

				expect(viaClass).toStrictEqual(viaFunction)
			}
		}
	})

	it("consumes one draw per step, so a shared generator's later draws are unmoved", () => {
		const random = mulberry32(20_260_913)
		const array = Array.from({ length: 50 }, (_, index) => index)

		shuffleWith(array, random)

		// fr-lieudit shuffles its pool and then draws from the same generator for the country fraction.
		// The next value must be the 50th-1 draw rather than a fresh stream's first.
		const expected = mulberry32(20_260_913)

		for (let step = 0; step < array.length - 1; step++) {
			expected()
		}

		expect(random()).toBe(expected())
	})

	it("steps each glibc generator exactly as the call site that pins it used to", () => {
		// The coarse-placer trainer: Math.imul, seeded 1234567, every shipped model trained on this order.
		let inlineInt32 = 1_234_567
		const homedInt32 = makeGlibcLcgInt32(1_234_567)

		// The conformal calibrator: float64 multiply, over its own seed derivation.
		let inlineFloat64 = (20_260_913 * 2_654_435_761 + 1) & 0xff_ff_ff_ff
		const homedFloat64 = makeGlibcLcgFloat64(inlineFloat64)

		for (let step = 0; step < 500; step++) {
			// oxlint-disable-next-line mailwoman/prefer-home -- the constants as each call site spelled them out, kept so the extraction is asserted against them rather than assumed faithful.
			inlineInt32 = (Math.imul(inlineInt32, 1_103_515_245) + 12_345) & 0x7f_ff_ff_ff
			// oxlint-disable-next-line mailwoman/prefer-home -- as above: the float64 stepping, verified against its home rather than trusted.
			inlineFloat64 = (inlineFloat64 * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff

			expect(homedInt32()).toBe(inlineInt32)
			expect(homedFloat64()).toBe(inlineFloat64)
		}
	})

	it("keeps the two glibc generators apart, despite identical constants", () => {
		const int32 = makeGlibcLcgInt32(1_234_567)
		const float64 = makeGlibcLcgFloat64(1_234_567)
		const fromInt32: number[] = []
		const fromFloat64: number[] = []

		for (let step = 0; step < 20; step++) {
			fromInt32.push(int32())
			fromFloat64.push(float64())
		}

		// Same multiplier and increment, and the first step agrees: 1234567 × 1103515245
		// is about 1.4e15, still under 2^53 where a double is exact.
		// The state then grows past it, `*` starts rounding where `Math.imul` wraps at 32 bits,
		// and the sequences part company on the second step.
		// So neither file's stream can be served by the other's generator, and a reader
		// comparing only the first value would conclude the opposite.
		expect(fromInt32[0]).toBe(fromFloat64[0])
		expect(fromInt32[1]).not.toBe(fromFloat64[1])
		expect(fromInt32).not.toStrictEqual(fromFloat64)
	})

	it("reproduces the modulo-indexed walk through shuffleBy, and not through shuffleWith", () => {
		// `conformal-calibrate.run.ts` derives its index as `state % (i + 1)` over a raw glibc LCG state.
		// That is the same walk with a different sampler, so `shuffleBy` reproduces it,
		// which is why that call site no longer keeps a loop.
		for (const size of [2, 17, 64, 500]) {
			for (const seed of SEEDS) {
				const mixed = (seed * 2_654_435_761 + 1) & 0xff_ff_ff_ff
				let state = mixed
				const inline = Array.from({ length: size }, (_, index) => index)

				// oxlint-disable-next-line mailwoman/prefer-home -- the walk as conformal-calibrate spelled it out, kept so the equivalence below is asserted rather than assumed.
				for (let index = inline.length - 1; index > 0; index--) {
					// oxlint-disable-next-line mailwoman/prefer-home -- the stepping as conformal-calibrate spelled it out, part of the copy this case exists to check.
					state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff

					const swap = state % (index + 1)

					;[inline[index], inline[swap]] = [inline[swap]!, inline[index]!]
				}

				const throughShared = Array.from({ length: size }, (_, index) => index)
				const step = makeGlibcLcgFloat64(mixed)

				shuffleBy(throughShared, (bound) => step() % bound)

				expect(throughShared).toStrictEqual(inline)
			}
		}

		// And the sampler is why: handing the same generator to `shuffleWith`,
		// which scales a float instead, does not reproduce it.
		// Routing this call site through the float sampler would have silently moved the split.
		const mixed = (20_260_913 * 2_654_435_761 + 1) & 0xff_ff_ff_ff
		const scaled = makeGlibcLcgFloat64(mixed)
		const viaFloat = Array.from({ length: 64 }, (_, index) => index)
		const viaModulo = Array.from({ length: 64 }, (_, index) => index)
		const modulo = makeGlibcLcgFloat64(mixed)

		shuffleWith(viaFloat, () => scaled() / 0x7f_ff_ff_ff)
		shuffleBy(viaModulo, (bound) => modulo() % bound)

		expect(viaFloat).not.toStrictEqual(viaModulo)
	})
})
