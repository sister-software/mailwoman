/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A bounded streaming shuffle over the rows headed for parquet, so a row-group is a sample of its source.
 */

import { shuffleWith } from "@mailwoman/core/random"

/**
 * Rows held in memory while shuffling, when the caller names no window; five 50,000-row groups,
 * which spans more than one output row-group and reaches `wof-admin`'s whole 13-country set,
 * while a window below `ROW_GROUP_SIZE` buys no wider mix.
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
