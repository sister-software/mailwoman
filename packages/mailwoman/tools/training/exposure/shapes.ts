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
