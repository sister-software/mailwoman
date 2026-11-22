// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Clock-to-string helpers shared by the artifact builders.
 */

/**
 * Formats the UTC calendar date as `yyyy-MM-DD`.
 *
 * Throws a RangeError if the date is invalid or the UTC year is outside 0000–9999.
 */
export function isoDate(now: Date = new Date()): string {
	return fourDigitISO(now).slice(0, 10)
}

/**
 * Formats the UTC instant at second precision with an explicit `+00:00` offset.
 *
 * The shape Python's `datetime.isoformat(timespec="seconds")` writes, so a manifest
 * built here and one built by the training code compare equal.
 * Throws a RangeError if the date is invalid or the UTC year is outside 0000–9999.
 */
export function isoSecondsUTC(now: Date = new Date()): string {
	return fourDigitISO(now).replace(/\.\d{3}Z$/, "+00:00")
}

/**
 * Formats the UTC instant at second precision with the `Z` suffix.
 *
 * The RFC 3339 shape the artifact manifests and eval reports stamp.
 * Throws a RangeError if the date is invalid or the UTC year is outside 0000–9999.
 */
export function isoSeconds(now: Date = new Date()): string {
	return fourDigitISO(now).replace(/\.\d{3}Z$/, "Z")
}

function fourDigitISO(date: Date): string {
	const iso = date.toISOString()

	if (iso[4] !== "-") throw new RangeError("The UTC year must be between 0000 and 9999")

	return iso
}

/**
 * The `date-time` production of RFC 3339 section 5.6: a full date, `T`, a full time
 * with optional fractional seconds, and `Z` or a numeric offset.
 * The letters may be lowercase.
 */
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/

/**
 * Lists the UTC dates with an announced positive leap second at 23:59:60.
 *
 * Update this list when IERS Bulletin C announces another leap second.
 * @see https://maia.usno.navy.mil/products/leap-second
 */
const UTC_LEAP_SECOND_DATES = new Set([
	"1972-06-30",
	"1972-12-31",
	"1973-12-31",
	"1974-12-31",
	"1975-12-31",
	"1976-12-31",
	"1977-12-31",
	"1978-12-31",
	"1979-12-31",
	"1981-06-30",
	"1982-06-30",
	"1983-06-30",
	"1985-06-30",
	"1987-12-31",
	"1989-12-31",
	"1990-12-31",
	"1992-06-30",
	"1993-06-30",
	"1994-06-30",
	"1995-12-31",
	"1997-06-30",
	"1998-12-31",
	"2005-12-31",
	"2008-12-31",
	"2012-06-30",
	"2015-06-30",
	"2016-12-31",
])

/**
 * The days in each month of a leap year, January first.
 */
const LEAP_YEAR_MONTH_DAYS: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * The largest hour of a day in an RFC 3339 time or offset.
 */
const LAST_HOUR = 23

/**
 * The largest minute of an hour.
 */
const LAST_MINUTE = 59

/**
 * The largest second of a minute: 60, because RFC 3339 admits a leap second.
 */
const LAST_SECOND_WITH_LEAP = 60

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Checks whether `value` is an RFC 3339 `date-time`, such as `2018-02-12T23:20:50Z`.
 *
 * Each field is checked against its range, so `2021-02-30T00:00:00Z` is refused.
 * A second of 60 must correspond to an announced UTC leap second after applying the offset.
 */
export function isRFC3339DateTime(value: string): boolean {
	const match = RFC3339_DATE_TIME.exec(value)

	if (!match) return false

	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	]

	const monthDays = LEAP_YEAR_MONTH_DAYS[month - 1]

	if (monthDays == null || day < 1) return false

	if (day > (month === 2 && !isLeapYear(year) ? monthDays - 1 : monthDays)) return false

	if (hour > LAST_HOUR || minute > LAST_MINUTE || second > LAST_SECOND_WITH_LEAP) return false

	const offsetHour = match[7]
	const offsetMinute = match[8]

	if (offsetHour != null && (Number(offsetHour) > LAST_HOUR || Number(offsetMinute) > LAST_MINUTE)) return false

	if (second < LAST_SECOND_WITH_LEAP) return true

	// Resolve the preceding second in UTC because JavaScript Date cannot represent second 60.
	const offset = offsetHour == null ? "Z" : value.slice(-6)
	const precedingSecond = new Date(`${value.slice(0, 16).toUpperCase()}:59${offset}`).toISOString()

	return precedingSecond.endsWith("T23:59:59.000Z") && UTC_LEAP_SECOND_DATES.has(precedingSecond.slice(0, 10))
}

/**
 * The wall-clock seconds one phase of a build took, under the phase's progress label.
 */
export interface PhaseTiming {
	phase: string
	seconds: number
}

/**
 * A clock that times the phases of a build from the phase names it reports.
 */
export interface PhaseClock {
	/**
	 * Starts `phase` and ends the phase that was running.
	 *
	 * A call naming the running phase leaves its start in place, so a phase that
	 * reports several progress lines is timed once.
	 * A phase that runs again later adds to its earlier time.
	 */
	mark(phase: string): void
	/**
	 * Ends the running phase and returns each phase's seconds, in the order the phases first ran.
	 */
	finish(): PhaseTiming[]
}

/**
 * The timings as one line, `ingest-wof 1234.5s, add-overture 61s`, in the order given.
 */
export function formatPhaseTimings(timings: readonly PhaseTiming[]): string {
	return timings.map(({ phase, seconds }) => `${phase} ${seconds}s`).join(", ")
}

/**
 * Creates a {@linkcode PhaseClock} reading `now` in milliseconds.
 */
export function createPhaseClock(now: () => number = () => performance.now()): PhaseClock {
	const elapsed = new Map<string, number>()
	let running: { phase: string; start: number } | null = null

	const stop = (end: number) => {
		if (!running) return
		elapsed.set(running.phase, (elapsed.get(running.phase) ?? 0) + (end - running.start))
		running = null
	}

	return {
		mark(phase) {
			if (running?.phase === phase) return
			const boundary = now()
			stop(boundary)
			running = { phase, start: boundary }
		},
		finish() {
			if (running) {
				stop(now())
			}

			return [...elapsed].map(([phase, ms]) => ({ phase, seconds: Math.round(ms / 100) / 10 }))
		},
	}
}
