import { stringifyJSON } from "@mailwoman/core/json"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Value tallies over a run's full results, aggregated beside the measurement so denominator discipline travels with it.
 *
 * Absence discipline: a path missing on a row tallies under {@link ABSENT_KEY} rather than being silently skipped, and
 * `null` tallies as the string "null" because a field explicitly set to null said something a missing field did not.
 */

/**
 * The bucket for rows where the dotted path does not exist; a leading tilde keeps it apart from real values.
 */
export const ABSENT_KEY = "~absent"

/**
 * Read a dotted path off a nested record; arrays are not traversed, because a tally
 * over array members is a different operation with a different denominator.
 */
export function readPath(value: unknown, path: string): { present: boolean; value: unknown } {
	let current: unknown = value

	for (const segment of path.split(".")) {
		if (current === null || current === undefined || typeof current !== "object" || Array.isArray(current)) {
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

		const key = !present
			? ABSENT_KEY
			: typeof value === "object" && value !== null
				? stringifyJSON(value)
				: String(value)

		counts[key] = (counts[key] ?? 0) + 1
	}

	return counts
}

/**
 * Tally several paths at once; every tally's counts sum to `rows.length` by construction,
 * which is why absence is a bucket instead of a skip.
 */
export function tallyPaths(
	rows: ReadonlyArray<unknown>,
	paths: ReadonlyArray<string>
): Record<string, Record<string, number>> {
	return Object.fromEntries(paths.map((path) => [path, tallyPath(rows, path)]))
}
