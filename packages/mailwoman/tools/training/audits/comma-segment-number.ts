/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts rows where a bare number occupies a comma-delimited segment by itself.
 *
 *   `301 College Ave, 101, Athens, GA 30601` is the surface #2298 would teach as a secondary unit. No token decides
 *   its reading, and the same shape is already attested as a house number (`15, 07691 Portopetro, …`) and as a
 *   postcode. A number at the start of a row is the house-number form several recipes emit. A number in a later
 *   segment is the shape under review, so the two positions are counted apart, by the tag each opens.
 */

import { isDecimalDigits } from "@mailwoman/core/strings/unicode"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode, SampledRow } from "@mailwoman/mtf/tools/sampler/native"

import { drawnRows, emittedRows, type CensusOptions } from "./census.ts"

function bare(token: string): string | null {
	const body = token.endsWith(",") ? token.slice(0, -1) : token

	return isDecimalDigits(body) ? body : null
}

/**
 * Every index where a digit group occupies its own comma segment: the segment opens at the comma
 * before the token, or the row's start, and closes at the comma after it, or the row's end.
 */
export function isolatedPositions(tokens: readonly string[]): number[] {
	const out: number[] = []

	for (const [index, token] of tokens.entries()) {
		if (bare(token) == null) continue

		const opens = index === 0 || tokens[index - 1]!.endsWith(",")
		const closes = token.endsWith(",") || index === tokens.length - 1

		if (opens && closes) {
			out.push(index)
		}
	}

	return out
}

/**
 * Isolated bare numbers by the tag they open, as `leading` (the row's first token) and `later`.
 */
export function commaSegmentCounts(rows: Iterable<Pick<SampledRow, "tokens" | "labels">>) {
	const counts: Record<"leading" | "later", Record<string, number>> = { leading: {}, later: {} }

	for (const row of rows) {
		const tokens = row.tokens ?? []
		const labels = row.labels ?? []

		for (const index of isolatedPositions(tokens)) {
			const label = labels[index] ?? "O"

			if (!label.startsWith("B-")) continue

			const where = index === 0 ? "leading" : "later"
			const tag = label.slice(2)

			counts[where][tag] = (counts[where][tag] ?? 0) + 1
		}
	}

	return counts
}

/**
 * Counts isolated bare numbers over `draws` rows, at the draw level and at the emitted level.
 */
export function commaSegmentNumberCensus(mtf: MTFNode, config: TrainingConfig, options: CensusOptions) {
	let rowsDrawn = 0

	const drawn = commaSegmentCounts(
		(function* () {
			for (const row of drawnRows(mtf, config, options)) {
				rowsDrawn++
				yield row
			}
		})()
	)

	const emitted = commaSegmentCounts(
		(function* () {
			for (const { row } of emittedRows(mtf, config, options)) {
				yield row
			}
		})()
	)

	return {
		meta: {
			seed: options.seed,
			draws_requested: options.draws,
			rows_drawn: rowsDrawn,
			corpus_dir: config.data.corpus_dir,
		},
		draw_level: drawn,
		emitted_level: emitted,
	}
}
