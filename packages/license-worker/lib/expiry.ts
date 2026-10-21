/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The expiry date of a token, decided by the intent that issued it. An evaluation lasts thirty days. An academic or
 *   student token lasts a year. An open-source or non-profit declaration expires on the quarter lead date nearest to
 *   its issue date plus four months, so a token lives between eleven and twenty-four weeks and every expiry falls
 *   three weeks before a calendar quarter starts. A commercial token's expiry is its billing period, decided where
 *   the paid invoice becomes a token.
 */

import type { LicenseIntent } from "@mailwoman/core/license/key"

import { calendarDateUTC, plusDays } from "#dates"

/**
 * The four dates a declaration can expire on, each 21 days before a calendar quarter starts.
 */
export const QUARTER_LEAD_DATES = ["03-11", "06-10", "09-10", "12-11"] as const

/**
 * The days an evaluation token lasts, decided by the operator on 2026-10-21:
 * long enough to see a paid tier work, and renewable only by declaring or paying.
 */
export const EVALUATION_DAYS = 30

/**
 * The days an academic or student token lasts, one academic year, decided by the operator on 2026-10-21.
 */
export const ACADEMIC_DAYS = 365

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * The months a declaration runs before it is drawn to the nearest lead date.
 */
const DECLARATION_MONTHS = 4

function dateParts(date: string): [year: number, month: number, day: number] {
	return date.split("-").map(Number) as [number, number, number]
}

/**
 * The day count since the epoch of a UTC calendar date, for distance arithmetic.
 */
function dayNumber(date: string): number {
	const [year, month, day] = dateParts(date)

	return Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY
}

/**
 * The whole days from one UTC calendar date to another, negative when `to` precedes `from`.
 */
export function daysBetween(from: string, to: string): number {
	return dayNumber(to) - dayNumber(from)
}

/**
 * The calendar date `months` after `date`.
 *
 * A day past the end of the target month rolls forward, as `Date.UTC` does,
 * so 2026-10-31 plus four months is 2027-03-03.
 */
export function plusMonths(date: string, months: number): string {
	const [year, month, day] = dateParts(date)

	return calendarDateUTC(Date.UTC(year, month - 1 + months, day) / 1000)
}

/**
 * The quarter lead date nearest to the target, with a tie going to the later date.
 */
export function nearestQuarterLead(target: string): string {
	const [year] = dateParts(target)
	const targetDay = dayNumber(target)
	let nearest: string | null = null
	let nearestDistance = Number.POSITIVE_INFINITY

	// Candidates are visited in ascending order, so an equal distance replaces the earlier date with the later one.
	for (const candidateYear of [year - 1, year, year + 1]) {
		for (const lead of QUARTER_LEAD_DATES) {
			const candidate = `${candidateYear}-${lead}`
			const distance = Math.abs(dayNumber(candidate) - targetDay)

			if (distance <= nearestDistance) {
				nearest = candidate
				nearestDistance = distance
			}
		}
	}

	if (nearest == null) throw new Error(`no quarter lead date near ${target}`)

	return nearest
}

/**
 * The expiry of an open-source or non-profit declaration issued on `issued`.
 */
export function declarationExpiry(issued: string): string {
	return nearestQuarterLead(plusMonths(issued, DECLARATION_MONTHS))
}

/**
 * The expiry date for a token of the given intent issued on `issued`.
 *
 * @throws for the commercial intent.
 * Its expiry is the billing period, decided when the paid invoice is turned into a token.
 */
export function expiryForIntent(intent: LicenseIntent, issued: string): string {
	switch (intent) {
		case "evaluation":
			return plusDays(issued, EVALUATION_DAYS)
		case "academic":
		case "student":
			return plusDays(issued, ACADEMIC_DAYS)
		case "open-source":
		case "non-profit":
			return declarationExpiry(issued)
		case "commercial":
			throw new Error(
				"a commercial token's expiry is its billing period end plus the grace days, decided when the invoice is paid"
			)
	}
}
