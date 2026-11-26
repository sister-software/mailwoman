// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The rows a training run is expected to draw from each source, and the sources
 *   whose draws fall between two runs.
 *
 *   A run draws a fixed number of rows, `max_steps × batch_size × grad_accum_steps`.
 *   The sampler shares them by weight over the total weight, a `source_weights` source by
 *   its weight and a `source_reps` source by the weight `derive_source_weights` gives it,
 *   so a source's draws depend on every other source's weight and none on its own row count.
 *
 *   A source added at a high weight therefore lowers every other source's draws. v8.11.0
 *   lowered 41 sources' draws by a factor of 0.559 that way (#3516).
 *   The report reads the sampler's own derivation through `resolveSourceWeights`.
 */

import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"
import type { MTFNode } from "@mailwoman/mtf/tools/sampler/native"

import { resolveSourceWeights } from "../audits/epoch/mixture.ts"
import { samplerConfigJSON } from "../sampler.ts"

/**
 * One source's expected draws in a run.
 */
export interface SourceDraws {
	source: string
	/**
	 * The source's train rows in the corpus.
	 */
	rows: number
	/**
	 * The rows the run is expected to draw from it.
	 */
	draws: number
}

/**
 * The run's expected draws per source, in the sampler's merged weight order.
 *
 * Country weights filter rows inside a source after the source is chosen,
 * so they don't change a source's draws.
 */
export function expectedDraws(mtf: MTFNode, config: TrainingConfig, corpusDir: string): SourceDraws[] {
	const rows = mtf.sourceRowCounts(samplerConfigJSON(config, { corpusDir }), "train")
	const rowsBySource = new Map(rows.map(({ source, count }) => [source, count]))
	const { weights } = resolveSourceWeights(mtf, config, corpusDir, rows)
	const positive = (weights ?? []).filter(([, weight]) => weight > 0)
	const total = positive.reduce((sum, [, weight]) => sum + weight, 0)
	const samples = config.train.max_steps * config.train.batch_size * config.train.grad_accum_steps

	return positive.map(([source, weight]) => ({
		source,
		rows: rowsBySource.get(source) ?? 0,
		draws: (samples * weight) / total,
	}))
}

/**
 * A source whose expected draws fell from one run to the next.
 */
export interface DrawFall {
	source: string
	previous: number
	current: number
	/**
	 * `1 − current / previous`.
	 */
	fall: number
}

/**
 * The sources drawn in both runs whose draws fell by more than `bound`, the largest fall first.
 *
 * A source the current run no longer draws is a fall of 1.
 * A source only the current run draws is no fall.
 */
export function drawFalls(
	previous: readonly SourceDraws[],
	current: readonly SourceDraws[],
	bound: number
): DrawFall[] {
	const now = new Map(current.map(({ source, draws }) => [source, draws]))

	return previous
		.filter(({ draws }) => draws > 0)
		.map(({ source, draws }) => {
			const drawn = now.get(source) ?? 0

			return { source, previous: draws, current: drawn, fall: 1 - drawn / draws }
		})
		.filter(({ fall }) => fall > bound)
		.toSorted((a, b) => b.fall - a.fall)
}
