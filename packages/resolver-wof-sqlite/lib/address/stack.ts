// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Counts the distinct addresses one source places at one point.
 */

/**
 * The SQL that lists every stacked point of an `address` table: each source and point,
 * rounded to 1e-5 degrees, with `n`, the distinct street-and-number pairs the source
 * places there, for points where `n` exceeds `minimum`.
 *
 * It selects `source_id`, `la`, `lo` and `n`.
 * The layer build, its duplicate rule and the pair sampler all read stacks through it,
 * so each counts a stack the same way.
 */
export function addressPointStacksSQL(minimum: number): string {
	return `SELECT source_id, round(lat, 5) AS la, round(lon, 5) AS lo, count(DISTINCT street_raw || '|' || number) AS n
		FROM address GROUP BY 1, 2, 3 HAVING n > ${Math.trunc(minimum)}`
}
