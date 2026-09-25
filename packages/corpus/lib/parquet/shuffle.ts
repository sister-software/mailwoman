/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A bounded streaming shuffle over the rows headed for parquet, so a row-group is a sample of its source.
 *
 *   `docs/engineering/reference/corpus-draw-coverage.mdx` records why this exists. A training run draws a bounded
 *   number of rows per source per epoch, and that draw reads one row-group: measured on `corpus-v0.5.0`, a row-group
 *   holds 50,000 rows and a source's epoch draw was 17,269. Rows reach parquet in adapter order. Adapter order is
 *   country order within a source: `wof-admin/part-0000.parquet` row-group 0 holds JP, CN, FR and US, while
 *   row-groups 10 and 19 hold 50,000 US rows each. A draw therefore sees between 1 and 11 of that source's 13
 *   countries.
 *
 *   Shuffling the loader's file order was written and reverted: it moves which row-group a draw lands in without
 *   widening it. The repair that works is to shuffle the rows before they are written, which this does.
 */

import { shuffleWith } from "@mailwoman/core/random"

/**
 * Rows held in memory while shuffling, when the caller names no window.
 *
 * Five row-groups at the 50,000-row group size.
 * A window has to span more than one row-group for an output row-group to mix countries
 * at all, and `wof-admin`'s census puts a median of 6 countries in a row-group,
 * so five row-groups' worth reaches that source's whole 13-country set.
 *
 * Raising it costs memory linearly and buys a wider mix.
 * Lowering it below `ROW_GROUP_SIZE` buys no wider mix, because the output row-group is
 * then drawn from fewer rows than it holds.
 */
export const DEFAULT_SHUFFLE_WINDOW = 250_000

/**
 * Seed for the shuffle when the caller names none.
 *
 * Fixed rather than drawn, so two builds of one input write the same row order
 * and a corpus is reproducible from its inputs.
 */
export const DEFAULT_SHUFFLE_SEED = 20_260_922

/**
 * Yield the input in an order shuffled within a sliding window of `windowSize` rows.
 *
 * Each arriving row displaces a uniformly chosen row from the buffer, which is emitted in its place.
 * The buffer is shuffled and drained at the end.
 *
 * Memory is bounded by the window rather than by the input, so a 685,678,230-row corpus streams through it.
 *
 * Sources stay effectively contiguous.
 * The loader filters rows by `source` per row rather than by file, so a source smeared across
 * every file would still load correctly, but it would read and discard far more to collect its draw.
 *
 * A window well below a source's row count keeps the smear to the boundary between two sources
 * while randomizing country order inside each one, which is the property the draw needs.
 *
 * `windowSize <= 1` yields the input unchanged and consumes no random draw, so a build that
 * asks for no shuffle produces the byte-identical stream it produced before this existed.
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
