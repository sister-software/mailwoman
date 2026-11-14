// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Compares a run's consumed rows per country–shape key with the retention table's retained keys.
 *
 *   A retention table (`#2893`, `SPLIT_RETENTION.floor-10.json`) keeps every row of a thin country–shape combination
 *   in training. The sampler draws a kept row only when the mixture reaches its source and country, so the report
 *   lists every retained key the run never consumed. The counts come from a replay of the configured mixture before launch, or from the
 *   `exposure-shapes-<step>.json` a Rust run writes at each checkpoint.
 */

import { shapeKeyOf } from "@mailwoman/corpus/utils/retention"

/**
 * Consumed rows per country–shape key.
 */
export type ShapeCounts = ReadonlyMap<string, number>

/**
 * One retained key's consumed count.
 */
export interface RetainedShapeExposure {
	key: string
	consumed: number
}

/**
 * How a set of consumed rows covers the retention table's retained keys.
 */
export interface ShapeExposureReport {
	retainedKeys: number
	/**
	 * Retained keys the rows drew at least once.
	 */
	drawn: number
	/**
	 * Retained keys the rows never drew.
	 *
	 * The operator investigates each one before the run trains further.
	 */
	undrawn: string[]
	consumedRows: number
	/**
	 * Every retained key's count, least-drawn first.
	 */
	byKey: RetainedShapeExposure[]
}

/**
 * Counts rows per country–shape key, as the trainer's checkpoint file does.
 */
export function countShapes(rows: Iterable<{ country?: string | null; spanTags?: readonly string[] | null }>): {
	counts: Map<string, number>
	rows: number
} {
	const counts = new Map<string, number>()
	let total = 0

	for (const row of rows) {
		total++

		if (!row.country || !row.spanTags) continue
		const key = shapeKeyOf(row.country, row.spanTags)
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}

	return { counts, rows: total }
}

/**
 * One source's drawable train rows, in total and per country–shape key.
 */
export interface SourceShapeRows {
	rows: number
	keys: Map<string, number>
}

/**
 * Counts each source's train rows per country–shape key, each row at the chance
 * the sampler admits its country (`weight / max weight`).
 *
 * A row with no country, a zero-weighted country or no span tags is never drawn as a keyed row,
 * so it counts toward its source's total only when its country is admitted.
 * An entry with `rows` stands for `rows` identical rows.
 */
export function countSourceShapes(
	rows: Iterable<{
		source: string | null
		country: string | null
		spanTags: readonly string[] | null
		rows?: number
	}>,
	countryWeights: Readonly<Record<string, number>>
): Map<string, SourceShapeRows> {
	const maxWeight = Math.max(0, ...Object.values(countryWeights))
	const bySource = new Map<string, SourceShapeRows>()

	for (const row of rows) {
		const weight = row.country == null ? 0 : (countryWeights[row.country] ?? 0)

		if (row.source == null || !(weight > 0)) continue

		const admission = (weight / maxWeight) * (row.rows ?? 1)
		let entry = bySource.get(row.source)

		if (!entry) {
			entry = { rows: 0, keys: new Map() }
			bySource.set(row.source, entry)
		}

		entry.rows += admission

		if (!row.spanTags) continue

		const key = shapeKeyOf(row.country!, row.spanTags)

		entry.keys.set(key, (entry.keys.get(key) ?? 0) + admission)
	}

	return bySource
}

/**
 * The draws the mixture intends per country–shape key over `draws` rows: each source's
 * requested share of the draws, spread over its keys in proportion to its rows.
 *
 * The intention is an expectation over seeds.
 * One epoch streams a source's files one after another and its row groups in shuffled blocks,
 * so a key held in a few row groups of a source read for less than one pass can draw far from it.
 *
 * A key flagged under-exposed is that variance or a sampler defect, and the report doesn't tell them apart.
 *
 * @throws For a requested source with no counted rows, since the sampler refuses one
 * and a missing count would otherwise read as an intention of zero.
 */
export function intendedShapeDraws(
	requested: ReadonlyMap<string, number>,
	draws: number,
	sources: ReadonlyMap<string, SourceShapeRows>
): Map<string, number> {
	const intended = new Map<string, number>()

	for (const [source, share] of requested) {
		const entry = sources.get(source)

		if (!entry || !(entry.rows > 0)) throw new Error(`requested source '${source}' has no counted train rows`)

		for (const [key, rows] of entry.keys) {
			intended.set(key, (intended.get(key) ?? 0) + (draws * share * rows) / entry.rows)
		}
	}

	return intended
}

/**
 * An upper bound on the chance of `observed` or fewer draws when `expected` are expected,
 * the Chernoff bound on a Poisson lower tail: `exp(-λ) (eλ/k)^k` for `k < λ`, 1 otherwise.
 */
export function poissonLowerTailBound(observed: number, expected: number): number {
	if (!(observed < expected)) return 1

	if (observed === 0) return Math.exp(-expected)

	return Math.exp(-expected + observed + observed * Math.log(expected / observed))
}

/**
 * The tail probability below which a key's consumed count is reported as under-exposed.
 *
 * It is a significance level stated in advance, fixed before any run is read.
 */
export const UNDER_EXPOSURE_LEVEL = 0.001

/**
 * One country–shape key's intended and consumed draws.
 */
export interface ShapeExposureRow {
	key: string
	intended: number
	consumed: number
	/**
	 * Whether the retention table keeps the key in training.
	 */
	retained: boolean
	/**
	 * An upper bound on the chance of drawing `consumed` or fewer at the intended rate.
	 */
	lowerTailBound: number
}

/**
 * How consumed rows compare with the mixture's intended draws, per key.
 */
export interface IntendedExposureReport {
	keys: number
	consumedRows: number
	intendedRows: number
	/**
	 * Retained keys the mixture is expected to draw less than once.
	 * The weights themselves leave these unseen.
	 */
	retainedBelowOneIntended: string[]
	/**
	 * Keys whose consumed count has a lower-tail bound under {@linkcode UNDER_EXPOSURE_LEVEL}
	 * at their intended draws.
	 */
	underExposed: string[]
	/**
	 * Consumed keys the mixture intends none of, such as a shape an augmentation writes.
	 */
	unintended: string[]
	/**
	 * Every key, least consumed relative to its intention first.
	 */
	byKey: ShapeExposureRow[]
}

/**
 * Compares consumed counts with intended draws over every key either names, and every retained key.
 */
export function intendedShapeExposure(
	intended: ReadonlyMap<string, number>,
	counts: ShapeCounts,
	consumedRows: number,
	retainedShapes: readonly string[]
): IntendedExposureReport {
	const retained = new Set(retainedShapes)
	const keys = new Set([...intended.keys(), ...counts.keys(), ...retained])

	const byKey = [...keys]
		.map((key) => {
			const expected = intended.get(key) ?? 0
			const consumed = counts.get(key) ?? 0

			return {
				key,
				intended: expected,
				consumed,
				retained: retained.has(key),
				lowerTailBound: poissonLowerTailBound(consumed, expected),
			}
		})
		.toSorted((a, b) => a.lowerTailBound - b.lowerTailBound || a.key.localeCompare(b.key))

	return {
		keys: byKey.length,
		consumedRows,
		intendedRows: [...intended.values()].reduce((sum, n) => sum + n, 0),
		retainedBelowOneIntended: byKey.filter((row) => row.retained && row.intended < 1).map((row) => row.key),
		underExposed: byKey.filter((row) => row.lowerTailBound < UNDER_EXPOSURE_LEVEL).map((row) => row.key),
		unintended: byKey.filter((row) => row.consumed > 0 && row.intended === 0).map((row) => row.key),
		byKey,
	}
}

/**
 * The exposure of every retained key in `counts`.
 */
export function shapeExposure(
	retainedShapes: readonly string[],
	counts: ShapeCounts,
	consumedRows: number
): ShapeExposureReport {
	const byKey = retainedShapes
		.map((key) => ({ key, consumed: counts.get(key) ?? 0 }))
		.toSorted((a, b) => a.consumed - b.consumed || a.key.localeCompare(b.key))

	const undrawn = byKey.filter((entry) => entry.consumed === 0).map((entry) => entry.key)

	return {
		retainedKeys: retainedShapes.length,
		drawn: retainedShapes.length - undrawn.length,
		undrawn,
		consumedRows,
		byKey,
	}
}
