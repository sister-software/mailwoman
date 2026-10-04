/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The three time concepts a claim needs: when the source observed the fact, when the record became
 *   available, and when the application retrieved it. A dossier built for an `asOf` date admits a record
 *   by its availability date alone, so a decision dated 2022 cannot rest on a record published in 2023.
 */

/**
 * An ISO 8601 date (`YYYY-MM-DD`) or timestamp.
 */
export type ISODate = string

export interface SourceTime {
	observedAt?: ISODate
	availableAt?: ISODate
	retrievedAt?: ISODate
}

export interface ClaimInterval {
	validFrom?: ISODate
	validTo?: ISODate
}

export type Admission = "admitted" | "excluded" | "undated"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/

// repo-health-ignore export-name-affix -- parses a text date; `isoDate` in core formats a Date and reads none.
export function isISODate(text: string): boolean {
	return ISO_DATE.test(text) && !Number.isNaN(Date.parse(text))
}

/**
 * A bare date sorts at the start of its day, so a date compares before a timestamp on the same day.
 */
// repo-health-ignore export-name-affix -- orders two text dates; `isoDate` in core formats a Date and compares none.
export function compareISODate(a: ISODate, b: ISODate): -1 | 0 | 1 {
	const left = Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a)
	const right = Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b)

	if (Number.isNaN(left) || Number.isNaN(right)) throw new Error(`compareISODate: unparseable date in ${a}, ${b}`)

	return left < right ? -1 : left > right ? 1 : 0
}

/**
 * A record without an availability date cannot be placed before or after the cutoff,
 * so it is undated rather than admitted.
 */
export function admitsAsOf(time: SourceTime, asOf: ISODate): Admission {
	if (time.availableAt === undefined) return "undated"

	return compareISODate(time.availableAt, asOf) <= 0 ? "admitted" : "excluded"
}

export function appliesAt(interval: ClaimInterval, date: ISODate): boolean | "unknown" {
	if (interval.validFrom === undefined && interval.validTo === undefined) return "unknown"

	if (interval.validFrom !== undefined && compareISODate(date, interval.validFrom) < 0) return false

	if (interval.validTo !== undefined && compareISODate(date, interval.validTo) > 0) return false

	return true
}
