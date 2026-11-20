// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The confidence of a postcode hit, derived from the data of the `postal` family.
 *
 *   The decoder prior scales its emission bias by a hit's confidence, and the locale hint
 *   and the script router compare it with a floor.
 *   The consumers therefore read it as one number: how sure the hit is that a span is a postcode.
 *
 *   # The rule
 *
 *   A form that one country accepts is evidence of a postcode, and a form that 56 countries
 *   accept (five digits) is evidence that the span might be any digit run.
 *   The confidence falls with the logarithm of the number of accepting countries:
 *
 *       confidence = CEILING - (CEILING - FLOOR) * ln(n) / ln(N) - NUMERIC_DISCOUNT (numeric forms only)
 *
 *   `n` is the number of countries whose syntax accepts the form, and `N` is
 *   the number of countries the family covers.
 *   A form a single country accepts scores the ceiling, and a form every country accepts scores the floor.
 *
 *   A bare run of digits, hyphens and white space (`numeric`) also scores `NUMERIC_DISCOUNT`
 *   lower, because such a run can be a house number or a count.
 *   A printed prefix (`designated`) and a form with a letter (`alnum`) take no discount.
 *
 *   The three constants are round numbers that no failing row fitted. 0.95 is the highest confidence
 *   the legacy table gave any pattern. 0.5 is the confidence the legacy locale hint gave an
 *   ambiguous five-digit run. 0.05 is the step between adjacent values of the legacy table.
 */

import type { PostalForm } from "#recognizer/postal/readers"

/**
 * The confidence of a form that one country accepts.
 */
export const POSTAL_CONFIDENCE_CEILING = 0.95

/**
 * The confidence of a form that every country of the family accepts.
 */
export const POSTAL_CONFIDENCE_FLOOR = 0.5

/**
 * What a bare run of digits, hyphens and white space loses.
 */
export const POSTAL_NUMERIC_DISCOUNT = 0.05

/**
 * The confidence of a postcode hit that a number of countries accept, in a family of `family` countries.
 *
 * @param countries The number of countries that accept the form, at least 1.
 * @param family The number of countries the family covers.
 */
export function postalConfidence(countries: number, form: PostalForm, family: number): number {
	const spread = family > 1 ? Math.log(Math.min(Math.max(countries, 1), family)) / Math.log(family) : 0
	const discount = form === "numeric" ? POSTAL_NUMERIC_DISCOUNT : 0

	return POSTAL_CONFIDENCE_CEILING - (POSTAL_CONFIDENCE_CEILING - POSTAL_CONFIDENCE_FLOOR) * spread - discount
}
