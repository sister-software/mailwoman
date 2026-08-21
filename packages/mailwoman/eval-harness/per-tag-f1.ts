/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Shared exact-match per-tag scoring for weight-dependent evaluation gates.
 */

import { existsSync } from "node:fs"

import { JSONSpliterator } from "spliterator"

export interface PerTagEvalRow {
	raw: string
	components: Record<string, string>
}

/**
 * Address component vocabulary used by the unfolded affix evaluation gates.
 */
export const UNFOLDED_ADDRESS_TAGS = [
	"street_prefix",
	"street",
	"street_suffix",
	"house_number",
	"locality",
	"region",
	"postcode",
	"country",
	"unit",
	"intersection_a",
	"intersection_b",
	"po_box",
	"cedex",
	"venue",
	"dependent_locality",
	"subregion",
] as const

export async function loadPerTagEvalRows(files: readonly string[]): Promise<PerTagEvalRow[]> {
	const rows: PerTagEvalRow[] = []

	for (const file of files) {
		if (!existsSync(file)) throw new Error(`eval file not found: ${file}`)

		for await (const row of JSONSpliterator.fromAsync<PerTagEvalRow>(file)) {
			rows.push(row)
		}
	}

	return rows
}

const normalizeComponent = (value?: string): string => (value ?? "").trim().toLowerCase()

export function rowsHaveTag(rows: readonly PerTagEvalRow[], tag: string): boolean {
	return rows.some((row) => Boolean(normalizeComponent(row.components[tag])))
}

/**
 * Compute exact-match F1 percentages. The caller owns inference so gates can choose their precise parse options without
 * duplicating the scoring implementation.
 */
export async function scorePerTagF1(
	rows: readonly PerTagEvalRow[],
	tags: readonly string[],
	classify: (raw: string) => Promise<Record<string, string>>
): Promise<Record<string, number>> {
	const statistics = Object.fromEntries(tags.map((tag) => [tag, { tp: 0, fp: 0, fn: 0 }]))

	for (const row of rows) {
		const predicted = await classify(row.raw)

		for (const tag of tags) {
			const expectedValue = normalizeComponent(row.components[tag])
			const predictedValue = normalizeComponent(predicted[tag])
			const statistic = statistics[tag]!

			if (expectedValue && predictedValue === expectedValue) {
				statistic.tp++
			} else {
				if (predictedValue) {
					statistic.fp++
				}

				if (expectedValue) {
					statistic.fn++
				}
			}
		}
	}

	return Object.fromEntries(
		tags.map((tag) => {
			const { tp, fp, fn } = statistics[tag]!
			const precision = tp + fp ? tp / (tp + fp) : 0
			const recall = tp + fn ? tp / (tp + fn) : 0
			const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0

			return [tag, +(100 * f1).toFixed(1)]
		})
	)
}
