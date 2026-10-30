/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts what a row's opening token teaches, at the draw level and at the emitted level.
 *
 *   A count is comparable only when its definition and its sampling level travel with it, so the opening-token
 *   definitions live here and are counted at both levels. The draw level counts rows straight off the mixture. The
 *   emitted level counts what fills the trainer's row budget after augmentation. Augmentation expands long addresses.
 *   A short-row source therefore takes a smaller share of the fixed budget there. A ratio across the two levels
 *   compares counts of different populations. The sampling is the epoch-mixture audit's: the same stream, seed convention and budget.
 */

import { isDecimalDigits } from "@mailwoman/core/strings/unicode"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode } from "@mailwoman/mtf/tools/sampler/native"

import { drawnRows, emittedRows, type CensusOptions } from "./census.ts"
import { sortedByKey } from "./receipt.ts"

/**
 * The openings counted, nested rather than rival: a row can match several.
 */
export const OPENING_NAMES = [
	"any_digits_house",
	"three_digits_house",
	"nnn_nn_house",
	"nnn_nn_house_whole_row",
	"any_digits_postcode",
	"three_digits_postcode",
	"nnn_nn_postcode",
	"nnn_nn_postcode_whole_row",
] as const

export type OpeningName = (typeof OPENING_NAMES)[number]

/**
 * The digits of the opening group the `three_digits` and `nnn_nn` openings name:
 * the `100` of the Czech `100 00`.
 */
const NNN = 3

/**
 * The digits of the group after it in an `nnn_nn` opening: the `00` of `100 00`.
 */
const NN = 2

/**
 * Every opening a row's tokens and labels match.
 */
export function openingCounts(tokens: readonly string[], labels: readonly string[]): OpeningName[] {
	const [first, second] = tokens
	const [label] = labels

	if (first == null || label == null || !isDecimalDigits(first)) return []

	const threeThenTwo = first.length === NNN && second != null && isDecimalDigits(second) && second.length === NN

	// A row of exactly two tokens is the failing input itself.
	// Its opening is shared with every in-context row that starts on its postcode,
	// so only the row length separates `100 00` from `100 00 Praha, Czechia`.
	const wholeRow = tokens.length === 2
	const kind = label === "B-house_number" ? "house" : label === "B-postcode" ? "postcode" : null

	if (!kind) return []

	const names: OpeningName[] = [`any_digits_${kind}`]

	if (first.length === NNN) {
		names.push(`three_digits_${kind}`)
	}

	if (threeThenTwo) {
		names.push(`nnn_nn_${kind}`)

		if (wholeRow) {
			names.push(`nnn_nn_${kind}_whole_row`)
		}
	}

	return names
}

type OpeningCounts = Record<OpeningName, number>

function zeroCounts(): OpeningCounts {
	return Object.fromEntries(OPENING_NAMES.map((name) => [name, 0])) as OpeningCounts
}

function ratio(counts: OpeningCounts, house: OpeningName, postcode: OpeningName): number | null {
	return counts[postcode] ? counts[house] / counts[postcode] : null
}

function level(counts: OpeningCounts, bySource: Map<string, OpeningCounts>) {
	return {
		counts,
		house_over_postcode: {
			any_digits: ratio(counts, "any_digits_house", "any_digits_postcode"),
			three_digits: ratio(counts, "three_digits_house", "three_digits_postcode"),
			nnn_nn: ratio(counts, "nnn_nn_house", "nnn_nn_postcode"),
			nnn_nn_whole_row: ratio(counts, "nnn_nn_house_whole_row", "nnn_nn_postcode_whole_row"),
		},
		by_source: Object.fromEntries(sortedByKey(bySource)),
	}
}

function tally(
	counts: OpeningCounts,
	bySource: Map<string, OpeningCounts>,
	row: { tokens: string[]; labels: string[]; source: string }
) {
	for (const name of openingCounts(row.tokens ?? [], row.labels ?? [])) {
		counts[name]++

		let per = bySource.get(row.source)

		if (!per) {
			per = zeroCounts()
			bySource.set(row.source, per)
		}

		per[name]++
	}
}

/**
 * Counts every opening over `draws` rows, at the draw level and at the emitted level.
 */
export function openingTokenCensus(mtf: MTFNode, config: TrainingConfig, options: CensusOptions) {
	const drawn = zeroCounts()
	const drawnBySource = new Map<string, OpeningCounts>()
	let rowsDrawn = 0

	for (const row of drawnRows(mtf, config, options)) {
		rowsDrawn++
		tally(drawn, drawnBySource, row)
	}

	const emitted = zeroCounts()
	const emittedBySource = new Map<string, OpeningCounts>()
	let rowsEmitted = 0

	for (const { row } of emittedRows(mtf, config, options)) {
		rowsEmitted++
		tally(emitted, emittedBySource, row)
	}

	return {
		meta: {
			seed: options.seed,
			draws_requested: options.draws,
			rows_drawn: rowsDrawn,
			rows_emitted: rowsEmitted,
			corpus_dir: config.data.corpus_dir,
		},
		draw_level: level(drawn, drawnBySource),
		emitted_level: level(emitted, emittedBySource),
	}
}
