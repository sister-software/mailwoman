/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts what a two-letter uppercase token teaches: a country or a region.
 *
 *   `NL` is a Canadian province code and the Netherlands' alpha-2 code, and the model reads whichever the corpus
 *   attested more (#2299). No code list is typed here: every two-letter uppercase token is counted under itself, so
 *   the contested set comes out of the data. Both levels are counted because `augment_region_prob` writes region
 *   surfaces onto rows that lacked one, so the draw level understates the region side by the augmentation's share.
 */

import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode, SampledRow } from "@mailwoman/mtf/tools/sampler/native"

import { drawnRows, emittedRows, type CensusOptions } from "../../census.ts"

/**
 * Whether a token is the shape of a subdivision or country code: two ASCII uppercase letters.
 */
export function codeShaped(token: string): boolean {
	return /^[A-Z]{2}$/.test(token)
}

/**
 * Every code-shaped token's count under the tag it opens, keyed by the token.
 *
 * A `B-` label opens a tag.
 * A token inside a longer span is part of a name.
 */
export function regionCodeCounts(
	rows: Iterable<Pick<SampledRow, "tokens" | "labels">>
): Map<string, Map<string, number>> {
	const counts = new Map<string, Map<string, number>>()

	for (const row of rows) {
		const tokens = row.tokens ?? []
		const labels = row.labels ?? []

		for (let i = 0; i < Math.min(tokens.length, labels.length); i++) {
			const token = tokens[i]!
			const label = labels[i]!

			if (!codeShaped(token) || !label.startsWith("B-")) continue

			const tag = label.slice(2)
			let tags = counts.get(token)

			if (!tags) {
				tags = new Map()
				counts.set(token, tags)
			}

			tags.set(tag, (tags.get(tag) ?? 0) + 1)
		}
	}

	return counts
}

/**
 * Codes read both ways, worst first: `[code, country, region]` ordered by the country-to-region ratio.
 */
export function contestedCodes(counts: Map<string, Map<string, number>>): Array<[string, number, number]> {
	const rows: Array<[string, number, number]> = []

	for (const [code, tags] of counts) {
		const country = tags.get("country") ?? 0
		const region = tags.get("region") ?? 0

		if (country && region) {
			rows.push([code, country, region])
		}
	}

	return rows.toSorted((a, b) => b[1] / Math.max(b[2], 1) - a[1] / Math.max(a[2], 1))
}

function plain(counts: Map<string, Map<string, number>>) {
	return Object.fromEntries([...counts].map(([code, tags]) => [code, Object.fromEntries(tags)]))
}

/**
 * Counts code-shaped tokens over `draws` rows, at the draw level and at the emitted level.
 */
export function regionCodeTokenCensus(mtf: MTFNode, config: TrainingConfig, options: CensusOptions) {
	let rowsDrawn = 0

	const drawnCounts = regionCodeCounts(
		(function* () {
			for (const row of drawnRows(mtf, config, options)) {
				rowsDrawn++
				yield row
			}
		})()
	)

	const emittedCounts = regionCodeCounts(
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
		draw_level: { counts: plain(drawnCounts), contested: contestedCodes(drawnCounts) },
		emitted_level: { counts: plain(emittedCounts), contested: contestedCodes(emittedCounts) },
	}
}
