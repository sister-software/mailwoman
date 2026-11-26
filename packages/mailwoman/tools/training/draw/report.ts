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
import { countryAdmission } from "../exposure/shapes.ts"
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
	/**
	 * The source's emitted rows per draw relative to the run's mean, from the config's
	 * `source_emit_factors`, 1 for a source the config gives none.
	 */
	emitFactor: number
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
	const factors = config.data.source_emit_factors ?? {}

	return positive.map(([source, weight]) => ({
		source,
		rows: rowsBySource.get(source) ?? 0,
		draws: (samples * weight) / total,
		emitFactor: factors[source] ?? 1,
	}))
}

/**
 * A source whose expected emitted rows fell from one run to the next.
 */
export interface DrawFall {
	source: string
	/**
	 * The previous run's expected emitted rows: its draws times the current run's emit factor.
	 */
	previous: number
	/**
	 * The current run's expected emitted rows.
	 */
	current: number
	/**
	 * `1 − current / previous`.
	 */
	fall: number
}

/**
 * The sources drawn in both runs whose expected emitted rows fell by more than
 * `bound`, the largest fall first.
 *
 * A source's emitted rows are its draws times its emit factor.
 * Both runs read the current run's factors, because a factor measures the source under the emit step.
 *
 * A config without a factor table emits its rows under the same step.
 *
 * A source the current run no longer draws is a fall of 1.
 * A source only the current run draws is no fall.
 */
export function drawFalls(
	previous: readonly SourceDraws[],
	current: readonly SourceDraws[],
	bound: number
): DrawFall[] {
	const now = new Map(current.map((entry) => [entry.source, entry]))

	return previous
		.filter(({ draws }) => draws > 0)
		.map(({ source, draws }) => {
			const entry = now.get(source)
			const factor = entry?.emitFactor ?? 1
			const before = draws * factor
			const after = (entry?.draws ?? 0) * factor

			return { source, previous: before, current: after, fall: 1 - after / before }
		})
		.filter(({ fall }) => fall > bound)
		.toSorted((a, b) => b.fall - a.fall)
}

/**
 * One source's train rows in one country.
 */
export interface SourceCountryRows {
	source: string
	country: string
	rows: number
}

/**
 * One country's expected draws in a run, over every source.
 */
export interface CountryDraws {
	country: string
	/**
	 * The country's train rows over every drawn source.
	 */
	rows: number
	draws: number
}

/**
 * The run's expected draws per country, the most drawn first.
 *
 * The sampler draws a source, then admits a row of country `c` with the chance
 * {@linkcode countryAdmission} gives and draws again from the same source on a refusal.
 * A source's draws therefore fall on its countries in proportion to rows times that chance.
 * A country with no positive weight is never drawn.
 */
export function expectedCountryDraws(
	draws: readonly SourceDraws[],
	countryRows: readonly SourceCountryRows[],
	countryWeights: Readonly<Record<string, number>>
): CountryDraws[] {
	const admit = countryAdmission(countryWeights)
	const bySource = Map.groupBy(countryRows, ({ source }) => source)
	const totals = new Map<string, CountryDraws>()

	for (const { source, draws: sourceDraws } of draws) {
		const rows = bySource.get(source) ?? []
		const accepted = rows.map((row) => ({ ...row, mass: row.rows * admit(row.country) }))
		const totalMass = accepted.reduce((sum, row) => sum + row.mass, 0)

		for (const { country, rows: count, mass: share } of accepted) {
			const total = totals.get(country) ?? { country, rows: 0, draws: 0 }

			total.rows += count
			total.draws += totalMass > 0 ? (sourceDraws * share) / totalMass : 0
			totals.set(country, total)
		}
	}

	return [...totals.values()].toSorted((a, b) => b.draws - a.draws)
}
