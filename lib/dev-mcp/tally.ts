import { stringifyJSON } from "@mailwoman/core/json"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * This module tallies values across every result in a run. Each aggregate stays beside its measurement so the denominator remains visible.
 *
 * A missing path tallies under {@link ABSENT_KEY}, so it remains in the denominator. An explicit `null` tallies as the string "null".
 */

/**
 * The bucket for rows where the dotted path does not exist.
 * A leading tilde keeps it apart from real values.
 */
export const ABSENT_KEY = "~absent"

/**
 * Read a dotted path off a nested record.
 *
 * Arrays are not traversed, because a tally over array members is a different
 * operation with a different denominator.
 */
export function readPath(value: unknown, path: string): { present: boolean; value: unknown } {
	let current: unknown = value

	for (const segment of path.split(".")) {
		if (current === null || !current || typeof current !== "object" || Array.isArray(current)) {
			return { present: false, value: undefined }
		}

		if (!(segment in (current as Record<string, unknown>))) {
			return { present: false, value: undefined }
		}

		current = (current as Record<string, unknown>)[segment]
	}

	return { present: true, value: current }
}

/**
 * Count distinct values at one dotted path across rows, tallying non-scalar values
 * under their JSON form so a structured field is not silently dropped.
 */
export function tallyPath(rows: ReadonlyArray<unknown>, path: string): Record<string, number> {
	const counts: Record<string, number> = {}

	for (const row of rows) {
		const { present, value } = readPath(row, path)

		const key = present ? (typeof value === "object" && value ? stringifyJSON(value) : String(value)) : ABSENT_KEY

		counts[key] = (counts[key] ?? 0) + 1
	}

	return counts
}

/**
 * Tally several paths at once.
 *
 * Each tally's counts sum to `rows.length`.
 * A missing-path bucket keeps those rows in the denominator.
 */
export function tallyPaths(
	rows: ReadonlyArray<unknown>,
	paths: ReadonlyArray<string>
): Record<string, Record<string, number>> {
	return Object.fromEntries(paths.map((path) => [path, tallyPath(rows, path)]))
}
