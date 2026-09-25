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
 * Returns `value` if it is an ISO `YYYY-MM-DD` date and throws otherwise.
 *
 * Temporal columns need ISO dates because `asOf` queries compare them as strings.
 * A vintage label such as "2026-Q2" would sort after every ISO date in its year.
 */
// repo-health-ignore export-name-affix -- The function rejects malformed input, which `isoDate` does not do.
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
