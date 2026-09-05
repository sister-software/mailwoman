/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Calendar dates in UTC, as the token carries them: a license runs to the end of its last day in UTC, so the arithmetic
 *   is on days, never on instants. `isoDate` in `@mailwoman/core/utils/time` has the same shape and sits behind core's
 *   Node-only graph, which this worker must not reach.
 */

export function calendarDateUTC(unixSeconds: number): string {
	// oxlint-disable-next-line mailwoman/prefer-home -- the home reaches node:os through core/env; the worker cannot
	return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

export function plusDays(date: string, days: number): string {
	const [year, month, day] = date.split("-").map(Number) as [number, number, number]

	// oxlint-disable-next-line mailwoman/prefer-home -- the home reaches node:os through core/env; the worker cannot
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}
