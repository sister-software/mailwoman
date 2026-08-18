/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Value tallies over a run's full results — the aggregation the recount scripts existed for.
 *
 *   The pattern this retires, named so it stays retired: every verdict census to date (`admin_coherence` counts on
 *   2026-08-17/18, the re-anchor after #1732) was a scratch script looping `session.geocode` and counting field values
 *   by hand, because `mwdev_run` returned rows and nothing counted across them. Aggregation belongs beside the
 *   measurement so the denominator discipline travels with it.
 *
 *   Absence discipline: a path that is missing on a row tallies under {@link ABSENT_KEY}, never silently skipped and
 *   never conflated with a value — "the field was not there" is a countable fact (the winner-less rows in a coherence
 *   census are a claim, not noise). `null` tallies as the string "null", distinct from absence, because a field
 *   explicitly set to null (`postcode_country_scope: null`) said something a missing field did not.
 */

/**
 * The bucket for rows where the dotted path does not exist. A leading tilde keeps it lexically apart from real values
 * and unmistakable in output.
 */
export const ABSENT_KEY = "~absent"

/**
 * Read a dotted path off a nested record. Arrays are not traversed — a tally over array members is a different
 * operation with a different denominator, and pretending otherwise double-counts rows.
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
 * Count distinct values at one dotted path across rows. Non-scalar values (objects) tally under their JSON form so a
 * structured field can still be tallied without a silent drop; scalars tally under `String(value)`.
 */
export function tallyPath(rows: ReadonlyArray<unknown>, path: string): Record<string, number> {
	const counts: Record<string, number> = {}

	for (const row of rows) {
		const { present, value } = readPath(row, path)

		const key = !present
			? ABSENT_KEY
			: typeof value === "object" && value !== null
				? JSON.stringify(value)
				: String(value)

		counts[key] = (counts[key] ?? 0) + 1
	}

	return counts
}

/**
 * Tally several paths at once. Every tally's counts sum to `rows.length` by construction — the invariant that makes
 * these readable as distributions rather than samples, and the reason absence is a bucket instead of a skip.
 */
export function tallyPaths(
	rows: ReadonlyArray<unknown>,
	paths: ReadonlyArray<string>
): Record<string, Record<string, number>> {
	return Object.fromEntries(paths.map((path) => [path, tallyPath(rows, path)]))
}
