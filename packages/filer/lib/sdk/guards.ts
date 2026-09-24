import { stringifyJSON } from "@mailwoman/core/json"

/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared validation for filer database writers.
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Require an ISO date for temporal columns, which use lexicographic comparisons in `asOf` queries.
 *
 * Keep free-form `source_vintage` labels separate; converting one to an edge date would be a guess.
 */
// repo-health-ignore export-name-affix -- a guard that refuses a malformed value; `isoDate` formats and validates none.
export function assertISODate(value: string, context: string, caller = "buildFilerDatabase"): string {
	if (!ISO_DATE_PATTERN.test(value)) {
		throw new Error(
			`${caller}: malformed ${context} — ${stringifyJSON(value)} is not an ISO YYYY-MM-DD date. ` +
				`valid_from/valid_to must always be ISO-sortable dates (decision 7 / criterion 1's asOf predicate is a ` +
				`plain string comparison over them) — a vintage LABEL like "2026-Q2" outranks every ISO date in its own ` +
				`year, so it would silently break every asOf-scoped read against the edge it's written to.`
		)
	}

	return value
}
