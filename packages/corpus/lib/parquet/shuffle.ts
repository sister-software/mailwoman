/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A bounded streaming shuffle over the rows headed for parquet, so a row-group is a sample of its source.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { mulberry32, shuffleWith } from "@mailwoman/core/random"

/**
 * Rows held in memory while shuffling, when the caller names no window.
 *
 * Five 50,000-row groups span more than one output row-group and reach `wof-admin`'s whole
 * 13-country set, while a window below `ROW_GROUP_SIZE` draws from no more than one row-group.
 */
export const DEFAULT_SHUFFLE_WINDOW = 250_000

/**
 * Seed for the shuffle when the caller names none, fixed rather than drawn so two builds
 * of one input write the same row order and a corpus is reproducible from its inputs.
 */
export const DEFAULT_SHUFFLE_SEED = 20_260_922

/**
 * Yield the input shuffled within a sliding window of `windowSize` rows, so memory is
 * bounded by the window rather than the input; `windowSize <= 1` yields the input unchanged
 * and consumes no random draw, keeping a no-shuffle build byte-identical.
 */
export async function* shuffleWithinWindow<T>(
	rows: AsyncIterable<T>,
	random: () => number,
	windowSize: number = DEFAULT_SHUFFLE_WINDOW
): AsyncGenerator<T> {
	if (windowSize <= 1) {
		yield* rows

		return
	}

	const buffer: T[] = []

	for await (const row of rows) {
		if (buffer.length < windowSize) {
			buffer.push(row)

			continue
		}

		const index = Math.floor(random() * buffer.length)
		const chosen = buffer[index]!
		buffer[index] = row

		yield chosen
	}

	shuffleWith(buffer, random)

	yield* buffer
}

/**
 * One split's rows as the corpus build writes them to parquet: shuffled within each source's run,
 * each source drawing from a generator seeded by the build's seed, the split's salt and the source id.
 *
 * Each split and source gets its own generator, so a file's row order depends only on its
 * own source's rows and not on how many rows other splits or sources happened to contain.
 */
export function shuffleSplitRows<T extends { source: string }>(
	rows: AsyncIterable<T>,
	opts: { seed: number; salt: number; window: number }
): AsyncGenerator<T> {
	return shuffleWithinSourceRuns(
		rows,
		(source) => mulberry32(sourceShuffleSeed(opts.seed + opts.salt, source)),
		opts.window
	)
}

/**
 * The salt each split's shuffle seed adds to the build's seed.
 */
export const SPLIT_SHUFFLE_SALT = { train: 0, val: 1, test: 2 } as const

/**
 * A 32-bit seed for one source's shuffle, from a base seed and the source id.
 */
export function sourceShuffleSeed(seed: number, source: string): number {
	return (seed + Number.parseInt(sha256Hex(source).slice(0, 8), 16)) >>> 0
}

/**
 * Yield rows shuffled within a sliding window per source, each source drawing from its own generator.
 *
 * A source's row order then depends on its own rows alone, so a file holding one
 * source has bytes that no other source's rows can change.
 * The corpus build writes a source's rows contiguously, so the window is flushed
 * when the source changes and memory stays bounded by one window.
 * A source that recurs later keeps its generator's state.
 *
 * @param randomFor Called once per source for that source's generator.
 */
export async function* shuffleWithinSourceRuns<T extends { source: string }>(
	rows: AsyncIterable<T>,
	randomFor: (source: string) => () => number,
	windowSize: number = DEFAULT_SHUFFLE_WINDOW
): AsyncGenerator<T> {
	if (windowSize <= 1) {
		yield* rows

		return
	}

	const generators = new Map<string, () => number>()
	let buffer: T[] = []
	let current: string | null = null

	const generator = (source: string): (() => number) => {
		let random = generators.get(source)

		if (!random) {
			random = randomFor(source)
			generators.set(source, random)
		}

		return random
	}

	for await (const row of rows) {
		if (current != null && row.source !== current) {
			shuffleWith(buffer, generator(current))

			yield* buffer

			buffer = []
		}

		current = row.source

		if (buffer.length < windowSize) {
			buffer.push(row)

			continue
		}

		const index = Math.floor(generator(current)() * buffer.length)
		const chosen = buffer[index]!
		buffer[index] = row

		yield chosen
	}

	if (current != null) {
		shuffleWith(buffer, generator(current))

		yield* buffer
	}
}
